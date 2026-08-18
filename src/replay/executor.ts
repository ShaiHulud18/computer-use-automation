/**
 * Deterministic replay executor — the production execution path.
 *
 * NO LLM ANYWHERE IN THIS FILE. Determinism is the contract: the same
 * artifact + the same inputs produce the same action sequence; the only
 * branching allowed is the artifact's own declared detector/recovery table
 * (plus one built-in, bounded wait-timeout retry). Everything exceptional
 * is either explained by a declared detector or reported as a debuggable
 * hard failure with evidence — never improvised around.
 *
 * Control-flow shape: each step runs as a small state machine
 * (action -> wait -> postcondition -> extract -> detector sweep), and every
 * abnormal observation funnels into ONE exception path that consults the
 * detector table. Business outcomes, bounded recoveries, hard failures and
 * human escalation are all decided there, so the error taxonomy lives in
 * exactly one place.
 */
import type {
  CapabilityArtifact,
  Condition,
  Detector,
  Recovery,
  Step,
  StepAction,
  TargetSpec,
} from "../schema/artifact.js";
import {
  ReplayResultSchema,
  type FailureDetail,
  type InterventionRecord,
  type RecoveryEvent,
  type ReplayResult,
  type StepReport,
} from "../schema/result.js";
import type { Surface } from "../surface/types.js";
import { enforce, type Policy } from "../safety/policy.js";
import type { InterventionBroker, InterventionOutcome } from "../hitl/types.js";
import type { RunLogger } from "../util/log.js";
import { redactParams } from "../util/redact.js";
import { substitute, validateInputs } from "./template.js";

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, string>;
  /** Applies artifact.tenantOverrides[tenant] (bindings + per-step targets). */
  tenant?: string;
  policy: Policy;
  surface: Surface;
  log: RunLogger;
  broker?: InterventionBroker;
  /** Pre-approval for risky steps when policy.riskyActionHandling === "confirm". */
  confirmRisky?: boolean;
  /** On an unexplained hard failure, offer the live session to a human instead of failing. */
  escalateOnFailure?: boolean;
  globalTimeoutMs?: number; // default 120_000
  /** Run a non-approved artifact anyway (also honored via ALLOW_DRAFT=1). */
  allowDraft?: boolean;
}

const DEFAULT_GLOBAL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const CHECKPOINT_POLL_MS = 5_000;
/** Max declared-recovery applications per step before we call it a hard failure. */
const MAX_RECOVERY_ATTEMPTS = 2;
/** Placeholder logged instead of a sensitive extracted value. */
const MASKED = "«masked»";

/**
 * How one step (or the synthetic checkpoint step) resolved. Internal only —
 * the public contract is ReplayResult.
 */
type Flow =
  | { kind: "continue"; status: "ok" | "recovered" | "human"; locatorUsed?: string }
  | { kind: "business_outcome"; code: string; message: string; locatorUsed?: string }
  | { kind: "hard_failure"; failure: FailureDetail; locatorUsed?: string }
  /** Human aborted mid-intervention. stepStatus records whether automation had executed the step. */
  | { kind: "aborted"; stepStatus: "skipped" | "failed"; locatorUsed?: string }
  | { kind: "completed_manually" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function describeCondition(c: Condition): string {
  switch (c.kind) {
    case "url_matches":
      return `url matches /${c.pattern}/`;
    case "text_visible":
      return `page text matches /${c.pattern}/`;
    case "element_visible":
      return `element visible: "${c.target.description}"`;
  }
}

/** What the step required — postcondition first, then wait, then target (spec order). */
function describeStepExpectation(step: Step): string {
  if (step.postcondition) return `postcondition: ${describeCondition(step.postcondition)}`;
  if (step.wait.until) return `wait: ${describeCondition(step.wait.until)}`;
  const target = "target" in step.action ? step.action.target : undefined;
  if (target) return `target actionable: "${target.description}"`;
  return step.intent;
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const { artifact, policy, surface, log } = opts;
  const ev = log.child("replay");
  const startedAt = nowIso();
  const globalTimeoutMs = opts.globalTimeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS;
  // Global deadline for AUTOMATION time. Time spent waiting on a human during
  // an intervention is credited back (see raiseIntervention) — a person
  // taking ten minutes must not turn a resumable run into a timeout failure.
  let deadline = Date.now() + globalTimeoutMs;
  const timeLeft = () => deadline - Date.now();

  const reports: StepReport[] = [];
  const recoveries: RecoveryEvent[] = [];
  const outputs: Record<string, string> = {};
  let intervention: InterventionRecord | undefined;

  /** Assemble, validate (dogfood the contract), log and return the result. */
  const finalize = (
    partial: Pick<ReplayResult, "status"> &
      Partial<Pick<ReplayResult, "outputs" | "outcome" | "failure">>,
  ): ReplayResult => {
    const result: ReplayResult = {
      runId: log.runId,
      capabilityId: artifact.capability.id,
      capabilityVersion: artifact.capability.version,
      startedAt,
      finishedAt: nowIso(),
      recoveries,
      steps: reports,
      evidenceDir: log.dir,
      ...(intervention ? { intervention } : {}),
      ...partial,
    };
    ev("finished", {
      status: result.status,
      steps: result.steps.length,
      recoveries: result.recoveries.length,
      evidenceDir: result.evidenceDir,
    });
    // Parsing our own output catches executor bugs at the boundary instead of
    // handing a malformed result to a calling agent.
    return ReplayResultSchema.parse(result);
  };

  /* ---------------------------------------------------------------- */
  /* Gate 0: draft/approved — the reviewability story                  */
  /* ---------------------------------------------------------------- */
  const allowDraft = opts.allowDraft ?? process.env.ALLOW_DRAFT === "1";
  if (artifact.capability.status !== "approved") {
    ev("gate.approval", {
      status: artifact.capability.status,
      allowed: allowDraft,
      via: opts.allowDraft !== undefined ? "option" : "env",
    });
    if (!allowDraft) {
      return finalize({
        status: "hard_failure",
        failure: {
          stepId: "approval-gate",
          stepIndex: -1,
          intent: "refuse unattended replay of unreviewed artifacts",
          expected: 'capability.status === "approved" (or allowDraft / ALLOW_DRAFT=1)',
          observed: `capability.status === "${artifact.capability.status}"`,
          evidence: [],
        },
      });
    }
  } else {
    ev("gate.approval", { status: "approved", allowed: true });
  }

  /* ---------------------------------------------------------------- */
  /* Gate 1: input validation — fail fast, zero browser actions        */
  /* ---------------------------------------------------------------- */
  const validated = validateInputs(artifact, opts.inputs);
  if (!validated.ok) {
    ev("inputs.invalid", { errors: validated.errors.join("; ") });
    return finalize({
      status: "hard_failure",
      failure: {
        stepId: "input-validation",
        stepIndex: -1,
        intent: "validate caller-supplied inputs against the contract",
        expected: "inputs satisfy the capability contract",
        observed: validated.errors.join("; "),
        evidence: [],
      },
    });
  }
  const sensitiveInputs = new Set(
    Object.entries(artifact.contract.inputs)
      .filter(([, spec]) => spec.sensitive)
      .map(([name]) => name),
  );
  // redactParams masks sensitive values at this log call; the logger's own
  // write-boundary redaction is pattern-based and would miss named params.
  ev("inputs.validated", { params: JSON.stringify(redactParams(policy, validated.values, sensitiveInputs)) });

  /* ---------------------------------------------------------------- */
  /* Tenant specialization                                              */
  /* ---------------------------------------------------------------- */
  let bindings: Record<string, string> = { ...artifact.bindings };
  const targetOverrides: Record<string, TargetSpec> = {};
  if (opts.tenant !== undefined) {
    const override = artifact.tenantOverrides[opts.tenant];
    if (override) {
      bindings = { ...bindings, ...(override.bindings ?? {}) };
      Object.assign(targetOverrides, override.targets ?? {});
      ev("tenant.applied", {
        tenant: opts.tenant,
        bindingOverrides: Object.keys(override.bindings ?? {}).length,
        targetOverrides: Object.keys(override.targets ?? {}).length,
      });
    } else {
      // A tenant with no overrides legitimately runs the stock artifact
      // (overrides exist to specialize, not to enroll) — but we log it so a
      // typo'd tenant name is visible in the run record.
      ev("tenant.no-overrides", { tenant: opts.tenant });
    }
  }

  const ctx = { inputs: validated.values, bindings };

  /** Steps with tenant target replacements applied (by stepId). */
  const steps: Step[] = artifact.steps.map((s) => {
    const replacement = targetOverrides[s.id];
    if (!replacement || !("target" in s.action)) return s;
    return { ...s, action: { ...s.action, target: replacement } };
  });

  /* ---------------------------------------------------------------- */
  /* Shared helpers (closures over run state)                           */
  /* ---------------------------------------------------------------- */

  /** A condition probe must never crash the run — an unevaluable condition is simply "false". */
  const checkSafe = async (c: Condition): Promise<boolean> => {
    try {
      return await surface.check(c);
    } catch {
      return false;
    }
  };

  /** Poll a condition every POLL_INTERVAL_MS until true, timeout, or global deadline. */
  const pollCondition = async (c: Condition, timeoutMs: number): Promise<boolean> => {
    const end = Math.min(Date.now() + timeoutMs, deadline);
    for (;;) {
      if (await checkSafe(c)) return true;
      if (Date.now() + POLL_INTERVAL_MS > end) return false;
      await sleep(POLL_INTERVAL_MS);
    }
  };

  /** Current URL + a short honest slice of visible page text (for failure records). */
  const observeState = async (): Promise<{ url: string; text: string }> => {
    try {
      const obs = await surface.observe({ screenshot: false });
      return { url: obs.url, text: obs.visibleText.replace(/\s+/g, " ").trim().slice(0, 300) };
    } catch {
      const url = await surface.location().catch(() => "(location unavailable)");
      return { url, text: "(page text unavailable)" };
    }
  };

  /** Best-effort evidence capture; a broken screenshot pipe must not mask the real failure. */
  const captureSafe = async (tag: string): Promise<string[]> => {
    try {
      const snap = await surface.captureEvidence(tag);
      return [snap.screenshotPath, snap.structurePath];
    } catch {
      return [];
    }
  };

  const buildFailure = async (
    stepId: string,
    stepIndex: number,
    intent: string,
    expected: string,
    evidenceTag: string,
    observedNote?: string,
  ): Promise<FailureDetail> => {
    const evidence = await captureSafe(evidenceTag);
    const state = await observeState();
    const observed = `${observedNote ? `${observedNote} — ` : ""}at ${state.url} :: "${state.text}"`;
    ev("failure", { stepId, expected, observed });
    return { stepId, stepIndex, intent, expected, observed, evidence };
  };

  /**
   * Detectors that apply at this step boundary, evaluated in taxonomy order:
   * business outcomes first (a legitimate answer beats any error reading),
   * then recoverables, then hard failures. Artifact order breaks ties within
   * a class. Returns the first whose condition currently holds.
   */
  const firstFiringDetector = async (stepId: string): Promise<Detector | null> => {
    const applicable = artifact.detectors.filter(
      (d) => d.appliesTo === "always" || d.appliesTo.includes(stepId),
    );
    for (const cls of ["business_outcome", "recoverable", "hard_failure"] as const) {
      for (const d of applicable) {
        if (d.classification.kind !== cls) continue;
        if (await checkSafe(d.condition)) return d;
      }
    }
    return null;
  };

  /**
   * Hand the live session to a human and block until they hand it back.
   * Time under human control is credited back to the automation deadline.
   */
  const raiseIntervention = async (reason: string, stepId: string): Promise<InterventionOutcome> => {
    const evidence = await captureSafe(`intervention-${stepId}`);
    const state = await observeState();
    ev("intervention.raise", { stepId, reason });
    const humanStart = Date.now();
    const outcome = await opts.broker!.raise({
      reason,
      capabilityId: artifact.capability.id,
      goal: artifact.provenance.goal,
      stepId,
      observedState: `at ${state.url} :: "${state.text}"`,
      ...(evidence[0] !== undefined ? { screenshotPath: evidence[0] } : {}),
    });
    deadline += Date.now() - humanStart;
    intervention = outcome.record;
    ev("intervention.resolved", { stepId, disposition: outcome.disposition });
    return outcome;
  };

  /** True if a template string references any input the contract marks sensitive. */
  const referencesSensitiveInput = (template: string): boolean => {
    for (const name of sensitiveInputs) {
      if (new RegExp(`\\{\\{\\s*inputs\\.${name}\\s*\\}\\}`).test(template)) return true;
    }
    return false;
  };

  /**
   * Substitute templates in the action's dynamic strings. Only navigate/fill/
   * select/press carry templated text; targets are recorded structures, never
   * templated. Also returns a log-safe rendering: when a value came from a
   * sensitive input we log the TEMPLATE form, not the resolved value, so the
   * secret never reaches the log file even pre-redaction.
   */
  const substituteAction = (
    action: StepAction,
  ): { action: StepAction; logForm: Record<string, unknown> } => {
    const targetDesc = "target" in action ? action.target.description : undefined;
    switch (action.type) {
      case "navigate": {
        const url = substitute(action.url, ctx);
        return {
          action: { ...action, url },
          logForm: { type: action.type, url: referencesSensitiveInput(action.url) ? action.url : url },
        };
      }
      case "fill":
      case "select": {
        const value = substitute(action.value, ctx);
        return {
          action: { ...action, value },
          logForm: {
            type: action.type,
            target: targetDesc,
            value: referencesSensitiveInput(action.value) ? action.value : value,
          },
        };
      }
      case "press": {
        const key = substitute(action.key, ctx);
        return {
          action: { ...action, key },
          logForm: {
            type: action.type,
            target: targetDesc,
            key: referencesSensitiveInput(action.key) ? action.key : key,
          },
        };
      }
      case "click":
      case "extract":
        return { action, logForm: { type: action.type, target: targetDesc } };
    }
  };

  /**
   * Perform an extract step's read. Returns a problem description or null.
   * readText is side-effect free, so re-running it after a recovery is safe.
   */
  const performExtract = async (
    step: Step,
    action: Extract<StepAction, { type: "extract" }>,
  ): Promise<string | null> => {
    const raw = await surface.readText(action.target).catch(() => null);
    if (raw === null) return `could not read text from "${action.target.description}"`;
    let value = raw.trim();
    if (action.parse !== undefined) {
      let re: RegExp;
      try {
        re = new RegExp(action.parse);
      } catch {
        return `artifact declares an invalid parse regex: ${action.parse}`;
      }
      const m = re.exec(value);
      const captured = m?.[1];
      if (captured === undefined) {
        return `extracted text did not match parse regex /${action.parse}/ (raw: "${value.slice(0, 80)}")`;
      }
      value = captured;
    }
    outputs[action.output] = value;
    const spec = artifact.contract.outputs[action.output];
    ev("step.extract", {
      stepId: step.id,
      output: action.output,
      value: spec?.sensitive ? MASKED : value,
    });
    return null;
  };

  const recordRecovery = (stepId: string, detectorId: string, recovery: string, attempts: number) => {
    const event: RecoveryEvent = { at: nowIso(), stepId, detectorId, recovery, attempts };
    recoveries.push(event);
    ev("step.recovery", { stepId, detectorId, recovery, attempts });
  };

  /** One-shot verification of a step's declared success conditions (no polling). */
  const quickVerify = async (step: Step): Promise<boolean> => {
    if (step.wait.until && !(await checkSafe(step.wait.until))) return false;
    if (step.postcondition && !(await checkSafe(step.postcondition))) return false;
    return true;
  };

  const globalTimeoutFailure = async (stepId: string, stepIndex: number, intent: string): Promise<FailureDetail> =>
    buildFailure(
      stepId,
      stepIndex,
      intent,
      `run completes within ${globalTimeoutMs}ms`,
      `failure-timeout-${stepId}`,
      "global timeout",
    );

  /* ---------------------------------------------------------------- */
  /* Per-step state machine                                             */
  /* ---------------------------------------------------------------- */

  const runStep = async (step: Step, idx: number): Promise<Flow> => {
    // Bounded loop: each iteration is one attempt at (re-)establishing the
    // step's success. Exits are: success, a terminal Flow, or the recovery
    // budget / escalation-retry flags forcing a hard failure.
    let recoveryAttempts = 0;
    let escalationRetryUsed = false;
    let recovered = false;
    let locatorUsed: string | undefined;
    // "action": run the step from scratch (policy -> act -> verify).
    // "verify": the action already took effect; only re-verify conditions
    // (used after a dismiss/wait_retry recovery so we never double-click).
    let phase: "action" | "verify" = "action";

    for (;;) {
      if (timeLeft() <= 0) {
        return {
          kind: "hard_failure",
          failure: await globalTimeoutFailure(step.id, idx, step.intent),
          locatorUsed,
        };
      }

      /** Non-null once this attempt has observed something wrong. */
      let problem: string | null = null;
      /** Where the problem arose — decides whether a recovery re-runs the action or just re-verifies. */
      let problemOrigin: "action" | "verification" = "verification";

      if (phase === "action") {
        /* (a) substitute + policy ------------------------------------ */
        let substituted: StepAction;
        try {
          const s = substituteAction(step.action);
          substituted = s.action;
          ev("step.start", { stepId: step.id, index: idx, intent: step.intent, action: JSON.stringify(s.logForm) });
        } catch (err) {
          // Unresolved placeholder = artifact/invocation mismatch. Nothing on
          // the page can explain it, so skip detector evaluation.
          return {
            kind: "hard_failure",
            failure: await buildFailure(
              step.id,
              idx,
              step.intent,
              "all template placeholders resolve against inputs/bindings",
              `failure-s${idx}`,
              err instanceof Error ? err.message : String(err),
            ),
            locatorUsed,
          };
        }

        const decision = enforce(policy, substituted, {
          currentUrl: await surface.location(),
          declaredRisk: step.risk,
          confirmed: opts.confirmRisky,
        });
        ev("step.policy", {
          stepId: step.id,
          allow: decision.allow,
          risk: decision.risk,
          ...(decision.allow ? {} : { reason: decision.reason }),
        });

        if (!decision.allow) {
          if (decision.escalate && opts.broker) {
            const outcome = await raiseIntervention(decision.reason, step.id);
            if (outcome.disposition === "resumed") {
              // The human performed this step in the live session. Trust but
              // verify: the declared postcondition is our only way to know the
              // handback left the flow in the state the next step assumes.
              if (step.postcondition) {
                await surface.settle(2_000).catch(() => {});
                const ok = await pollCondition(step.postcondition, CHECKPOINT_POLL_MS);
                if (!ok) {
                  return {
                    kind: "hard_failure",
                    failure: await buildFailure(
                      step.id,
                      idx,
                      step.intent,
                      describeCondition(step.postcondition),
                      `failure-s${idx}`,
                      "human handback left unexpected state",
                    ),
                    locatorUsed,
                  };
                }
              }
              return { kind: "continue", status: "human", locatorUsed };
            }
            if (outcome.disposition === "completed_manually") return { kind: "completed_manually" };
            // aborted: automation never executed this step.
            return { kind: "aborted", stepStatus: "skipped", locatorUsed };
          }
          // Refused with no escalation route (blocked, unconfirmed, or no broker).
          return {
            kind: "hard_failure",
            failure: {
              stepId: step.id,
              stepIndex: idx,
              intent: step.intent,
              expected: "policy allows action",
              observed: decision.reason,
              evidence: await captureSafe(`policy-refused-s${idx}`),
            },
            locatorUsed,
          };
        }

        /* (b) resolve + act ------------------------------------------ */
        const target = "target" in substituted ? substituted.target : undefined;
        if (target) {
          // Resolve once here purely for locator telemetry (drift monitoring
          // needs to know which rung of the ladder won). surface.act() will
          // resolve again internally — an accepted double-resolve: resolveTarget
          // is side-effect free and cheap, and it keeps Surface.act's contract
          // self-contained instead of threading resolved handles across calls.
          const res = await surface.resolveTarget(target).catch(() => null);
          if (res === null) {
            problem = `target "${target.description}" did not resolve via any locator candidate`;
            problemOrigin = "action";
          } else {
            const strategy = target.candidates[res.candidateIndex]?.strategy ?? "unknown";
            locatorUsed = `candidate[${res.candidateIndex}]:${strategy}`;
            ev("step.locator", { stepId: step.id, locatorUsed });
          }
        }

        if (problem === null && substituted.type !== "extract") {
          // Extract steps have no side effect to perform here — their "act"
          // is the readText in (f), after conditions verify.
          try {
            await surface.act(substituted);
          } catch (err) {
            // TargetResolutionError is matched BY NAME, not instanceof: the
            // class lives in a concrete Surface implementation and importing
            // it (even as a type) would couple the executor to one surface.
            // Any driver can signal "the ladder found nothing" via err.name.
            const name = err instanceof Error ? err.name : "";
            const msg = err instanceof Error ? err.message : String(err);
            problem =
              name === "TargetResolutionError"
                ? `target resolution failed during act: ${msg}`
                : `action failed: ${msg}`;
            problemOrigin = "action";
          }
        }
      }

      /* (c) wait ------------------------------------------------------ */
      if (problem === null) {
        if (step.wait.until) {
          let ok = await pollCondition(step.wait.until, step.wait.timeoutMs);
          if (!ok && timeLeft() > 0) {
            // Built-in bounded recovery for transient slowness (e.g. a 12s
            // "slow" fault against a 10s step timeout): settle, breathe 2s,
            // re-check ONCE. Logged as a recovery so reliability trends show
            // up, but it never loops.
            recordRecovery(step.id, "builtin-timeout-retry", "wait_retry", 1);
            await surface.settle(2_000).catch(() => {});
            await sleep(2_000);
            ok = await checkSafe(step.wait.until);
          }
          if (!ok) {
            problem = `wait condition not met within ${step.wait.timeoutMs}ms (+built-in retry): ${describeCondition(step.wait.until)}`;
          }
        } else {
          // No declared condition: fall back to the surface's idle heuristic.
          // A settle timeout is NOT itself a failure — the postcondition and
          // detector sweep are the arbiters of step health.
          await surface.settle(step.wait.timeoutMs).catch(() => {});
        }
      }

      /* (d) postcondition ---------------------------------------------- */
      if (problem === null && step.postcondition) {
        if (!(await checkSafe(step.postcondition))) {
          problem = `postcondition not met: ${describeCondition(step.postcondition)}`;
        }
      }

      /* (f) extract (only once the step verified) ----------------------- */
      if (problem === null && step.action.type === "extract") {
        problem = await performExtract(step, step.action);
        if (problem !== null) problemOrigin = "action"; // re-running the read is the fix, and it is side-effect free
      }

      /* (e) detector sweep — runs after success AND on any problem ------ */
      const detector = await firstFiringDetector(step.id);

      if (detector === null && problem === null) {
        ev("step.ok", { stepId: step.id, status: recovered ? "recovered" : "ok" });
        return { kind: "continue", status: recovered ? "recovered" : "ok", locatorUsed };
      }

      if (detector?.classification.kind === "business_outcome") {
        // A legitimate, enumerated answer (e.g. "no member records") — even
        // when the step itself "succeeded". Not an error; evidence captured
        // because callers audit outcomes too.
        const code = detector.classification.code;
        await captureSafe(`outcome-${code}`);
        ev("step.business-outcome", { stepId: step.id, detectorId: detector.id, code });
        return { kind: "business_outcome", code, message: detector.description, locatorUsed };
      }

      if (detector?.classification.kind === "recoverable") {
        if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
          // Budget exhausted: a "recoverable" state that keeps coming back is
          // not recoverable. Fall through to hard-failure handling below.
          problem = problem ?? `recoverable detector "${detector.id}" still firing`;
        } else {
          recoveryAttempts += 1;
          recovered = true;
          const recovery: Recovery = detector.classification.recovery;
          recordRecovery(step.id, detector.id, recovery.type, recoveryAttempts);

          switch (recovery.type) {
            case "dismiss": {
              // Even declared recoveries go through the policy choke point —
              // the artifact is reviewed, but the choke point is absolute.
              const click: StepAction = { type: "click", target: recovery.target };
              const d = enforce(policy, click, {
                currentUrl: await surface.location(),
                declaredRisk: "safe",
              });
              if (d.allow) {
                await surface.act(click).catch(() => {});
                await surface.settle().catch(() => {});
              } else {
                ev("step.recovery-refused", { stepId: step.id, reason: d.reason });
              }
              break;
            }
            case "reload_and_retry_step": {
              const url = await surface.location();
              const nav: StepAction = { type: "navigate", url };
              const d = enforce(policy, nav, { currentUrl: url, declaredRisk: "safe" });
              if (d.allow) await surface.act(nav).catch(() => {});
              else ev("step.recovery-refused", { stepId: step.id, reason: d.reason });
              break;
            }
            case "wait_retry": {
              // Sleep/re-check up to `times`; the formal re-verification below
              // confirms (or refutes) whatever this loop observed.
              for (let t = 0; t < recovery.times; t++) {
                if (timeLeft() <= 0) break;
                await sleep(recovery.delayMs);
                if (await quickVerify(step)) break;
              }
              break;
            }
          }

          // reload_and_retry_step re-runs the whole step from (a). dismiss and
          // wait_retry re-run the action only if the ACTION was what failed
          // (e.g. an interstitial swallowed the click); otherwise the action
          // already took effect and re-running it could double-submit, so we
          // only re-verify.
          phase =
            recovery.type === "reload_and_retry_step" || problemOrigin === "action"
              ? "action"
              : "verify";
          continue;
        }
      }

      /* Hard failure: a hard_failure detector fired, nothing explains the
         state, or the recovery budget ran out. ------------------------- */
      const detectorReason =
        detector?.classification.kind === "hard_failure" ? detector.classification.reason : undefined;
      const failure = await buildFailure(
        step.id,
        idx,
        step.intent,
        describeStepExpectation(step),
        `failure-s${idx}`,
        detectorReason ?? problem ?? "unexplained state",
      );

      if (opts.escalateOnFailure && opts.broker && !escalationRetryUsed) {
        const outcome = await raiseIntervention(
          `step "${step.id}" failed: ${detectorReason ?? problem ?? "unexplained state"}`,
          step.id,
        );
        if (outcome.disposition === "resumed") {
          // The human may have repaired state (e.g. re-signed-in). Retry the
          // step ONCE from scratch; a second failure returns without re-asking.
          escalationRetryUsed = true;
          phase = "action";
          continue;
        }
        if (outcome.disposition === "completed_manually") return { kind: "completed_manually" };
        return { kind: "aborted", stepStatus: "failed", locatorUsed };
      }

      return { kind: "hard_failure", failure, locatorUsed };
    }
  };

  /* ---------------------------------------------------------------- */
  /* Checkpoint verification (synthetic final step "checkpoint")        */
  /* ---------------------------------------------------------------- */

  const runCheckpoint = async (): Promise<Flow> => {
    let recoveryAttempts = 0;
    let escalationUsed = false;

    for (;;) {
      if (timeLeft() <= 0) {
        return {
          kind: "hard_failure",
          failure: await globalTimeoutFailure("checkpoint", steps.length, "verify final checkpoint"),
        };
      }

      // Poll until ALL conditions hold simultaneously, up to 5s. Success is
      // asserted, never assumed — this is the artifact's own definition of done.
      const end = Math.min(Date.now() + CHECKPOINT_POLL_MS, deadline);
      let allOk = false;
      for (;;) {
        allOk = true;
        for (const c of artifact.checkpoint.conditions) {
          if (!(await checkSafe(c))) {
            allOk = false;
            break;
          }
        }
        if (allOk || Date.now() + POLL_INTERVAL_MS > end) break;
        await sleep(POLL_INTERVAL_MS);
      }
      if (allOk) {
        ev("checkpoint.ok", { description: artifact.checkpoint.description });
        return { kind: "continue", status: "ok" };
      }

      // Same exception path as steps, for the synthetic stepId "checkpoint".
      const detector = await firstFiringDetector("checkpoint");
      if (detector?.classification.kind === "business_outcome") {
        const code = detector.classification.code;
        await captureSafe(`outcome-${code}`);
        ev("checkpoint.business-outcome", { detectorId: detector.id, code });
        return { kind: "business_outcome", code, message: detector.description };
      }
      if (detector?.classification.kind === "recoverable" && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
        recoveryAttempts += 1;
        const recovery = detector.classification.recovery;
        recordRecovery("checkpoint", detector.id, recovery.type, recoveryAttempts);
        switch (recovery.type) {
          case "dismiss": {
            const click: StepAction = { type: "click", target: recovery.target };
            const d = enforce(policy, click, { currentUrl: await surface.location(), declaredRisk: "safe" });
            if (d.allow) {
              await surface.act(click).catch(() => {});
              await surface.settle().catch(() => {});
            }
            break;
          }
          case "reload_and_retry_step": {
            const url = await surface.location();
            const d = enforce(policy, { type: "navigate", url }, { currentUrl: url, declaredRisk: "safe" });
            if (d.allow) await surface.act({ type: "navigate", url }).catch(() => {});
            break;
          }
          case "wait_retry": {
            for (let t = 0; t < recovery.times; t++) {
              if (timeLeft() <= 0) break;
              await sleep(recovery.delayMs);
            }
            break;
          }
        }
        continue; // re-poll the checkpoint
      }

      const expected = `${artifact.checkpoint.description} (${artifact.checkpoint.conditions
        .map(describeCondition)
        .join(" AND ")})`;
      const failure = await buildFailure(
        "checkpoint",
        steps.length,
        "verify final checkpoint",
        expected,
        "failure-checkpoint",
        detector?.classification.kind === "hard_failure" ? detector.classification.reason : undefined,
      );

      if (opts.escalateOnFailure && opts.broker && !escalationUsed) {
        const outcome = await raiseIntervention(`checkpoint failed: ${expected}`, "checkpoint");
        if (outcome.disposition === "aborted") return { kind: "aborted", stepStatus: "failed" };
        // "resumed" and "completed_manually" both mean: the human believes the
        // state is now (or was already) correct — re-verify once, no re-asking.
        escalationUsed = true;
        continue;
      }
      return { kind: "hard_failure", failure };
    }
  };

  /* ---------------------------------------------------------------- */
  /* Main loop                                                          */
  /* ---------------------------------------------------------------- */

  const markSkipped = (from: number) => {
    for (let j = from; j < steps.length; j++) {
      const s = steps[j]!;
      reports.push({ stepId: s.id, intent: s.intent, status: "skipped", durationMs: 0 });
    }
  };

  let completedManually = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;

    if (timeLeft() <= 0) {
      const failure = await globalTimeoutFailure(step.id, i, step.intent);
      reports.push({ stepId: step.id, intent: step.intent, status: "failed", durationMs: 0 });
      markSkipped(i + 1);
      return finalize({ status: "hard_failure", failure });
    }

    const t0 = Date.now();
    const flow = await runStep(step, i);
    const durationMs = Date.now() - t0;
    const report = (status: StepReport["status"]): StepReport => ({
      stepId: step.id,
      intent: step.intent,
      status,
      ...(flow.kind !== "completed_manually" && flow.locatorUsed !== undefined
        ? { locatorUsed: flow.locatorUsed }
        : {}),
      durationMs,
    });

    switch (flow.kind) {
      case "continue":
        reports.push(report(flow.status));
        break;
      case "business_outcome":
        // The step's action ran; the flow ended with a declared answer — that
        // is an "ok" step, not a failed one.
        reports.push(report("ok"));
        markSkipped(i + 1);
        return finalize({
          status: "business_outcome",
          outcome: { code: flow.code, message: flow.message },
        });
      case "hard_failure":
        reports.push(report("failed"));
        markSkipped(i + 1);
        return finalize({ status: "hard_failure", failure: flow.failure });
      case "aborted":
        reports.push(report(flow.stepStatus));
        markSkipped(i + 1);
        return finalize({ status: "intervention" });
      case "completed_manually":
        // Human drove the session to the goal; the current step is theirs and
        // the rest never run. Checkpoint still decides success.
        reports.push(report("human"));
        markSkipped(i + 1);
        completedManually = true;
        break;
    }
    if (completedManually) break;
  }

  const cp = await runCheckpoint();
  if (cp.kind === "business_outcome") {
    return finalize({ status: "business_outcome", outcome: { code: cp.code, message: cp.message } });
  }
  if (cp.kind === "hard_failure") {
    return finalize({ status: "hard_failure", failure: cp.failure });
  }
  if (cp.kind === "aborted") {
    return finalize({ status: "intervention" });
  }

  /* Success: every declared output must actually have been extracted —
     unless a human completed the flow manually, in which case extraction
     steps legitimately never ran and the caller gets what exists. */
  const missing = Object.keys(artifact.contract.outputs).filter((k) => !(k in outputs));
  if (missing.length > 0) {
    if (completedManually) {
      ev("outputs.partial", {
        note: "flow completed manually by a human; unextracted outputs omitted",
        missing: missing.join(", "),
      });
    } else {
      return finalize({
        status: "hard_failure",
        failure: {
          stepId: "outputs-verification",
          stepIndex: steps.length,
          intent: "verify all contract outputs were extracted",
          expected: `outputs present: ${Object.keys(artifact.contract.outputs).join(", ")}`,
          observed: `declared output never extracted: ${missing.join(", ")}`,
          evidence: [],
        },
      });
    }
  }

  return finalize({ status: "success", outputs });
}
