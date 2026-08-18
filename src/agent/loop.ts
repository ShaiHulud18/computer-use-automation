/**
 * LLM discovery loop — the "model discovers" half of the system.
 *
 * The model drives a live surface one tool call at a time. Every turn it
 * receives the current observation (URL, title, numbered element list, capped
 * visible text, and a screenshot) and must respond with exactly one tool call:
 * act / extract / finish / escalate.
 *
 * Safety shape (WHY it looks like this):
 *  - Every action passes through the ONE policy choke point (`enforce`)
 *    before it touches the surface. Refusals are fed back to the model as
 *    tool errors so it can adapt; escalations block on a human broker.
 *  - The model only ever sees ephemeral refs; the recorder captures the full
 *    element descriptors so the compiler — not the model — decides how the
 *    flow generalizes.
 *  - Evidence: every model request/response is summarized (screenshots
 *    elided, secrets scrubbed, patterns redacted) into transcript.jsonl in
 *    the run directory, so a reviewer can audit exactly what the model was
 *    told and what it decided.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { CapabilityArtifact, OutputSpec, ParamSpec } from "../schema/artifact.js";
import { enforce, type Policy } from "../safety/policy.js";
import type { DiscoveryAction, Observation, ObservedElement } from "../surface/types.js";
import type { WebSurface } from "../surface/web.js";
import type { InterventionBroker, InterventionOutcome } from "../hitl/types.js";
import type { RunLogger } from "../util/log.js";
import { redactValue } from "../util/redact.js";
import { TraceRecorder } from "./recorder.js";
import { compileArtifact } from "./compiler.js";
import {
  ActInputSchema,
  EscalateInputSchema,
  ExtractInputSchema,
  FinishInputSchema,
  FIRST_TURN_FRAMING,
  TOOL_DEFINITIONS,
  buildSystemPrompt,
  renderObservation,
  type ActInput,
  type EscalateInput,
  type ExtractInput,
  type FinishInput,
} from "./prompts.js";

/* ------------------------------------------------------------------ */
/* Public contract                                                      */
/* ------------------------------------------------------------------ */

export interface DiscoverySpec {
  goal: string;
  capabilityId: string;
  capabilityName: string;
  appId: string;
  entrypoint: string; // e.g. http://localhost:4173/
  /** Concrete values for THIS run + the ParamSpec that generalizes them. */
  inputs: Record<string, { value: string; spec: ParamSpec }>;
  outputs: Record<string, OutputSpec>;
  maxSteps?: number; // default 25
  model?: string; // default process.env.MODEL ?? "claude-sonnet-4-5"
}

export interface DiscoveryOutcome {
  status: "success" | "gave_up" | "escalated_abort";
  artifactPath?: string;
  artifact?: CapabilityArtifact;
  outputs?: Record<string, string>;
  stepsTaken: number;
  /** Evidence: redacted model transcript (JSONL). */
  transcriptPath: string;
}

/* ------------------------------------------------------------------ */
/* Internals                                                            */
/* ------------------------------------------------------------------ */

/** Matches the mask used by util/redact.ts so evidence reads uniformly. */
const MASK = "▓▓REDACTED▓▓";

/**
 * The installed SDK generation has no `ContentBlockParam` alias — user/assistant
 * message content is this inline union. Named here once so the loop reads clearly.
 */
type ContentBlockParam =
  | Anthropic.Messages.TextBlockParam
  | Anthropic.Messages.ImageBlockParam
  | Anthropic.Messages.ToolUseBlockParam
  | Anthropic.Messages.ToolResultBlockParam;

/** Artifacts live at the repo root regardless of the process cwd. */
const CAPABILITIES_DIR = fileURLToPath(new URL("../../capabilities/", import.meta.url));

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** version = 1 + max existing version for this capability id. */
function nextVersion(dir: string, capabilityId: string): number {
  if (!fs.existsSync(dir)) return 1;
  const pattern = new RegExp(`^${escapeRegExp(capabilityId)}\\.v(\\d+)\\.json$`);
  let max = 0;
  for (const file of fs.readdirSync(dir)) {
    const m = pattern.exec(file);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function zodIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** What a tool handler produces: feedback for the next turn, or the end of the run. */
type HandlerResult =
  | { kind: "feedback"; content: string; isError?: boolean }
  | { kind: "terminal"; outcome: DiscoveryOutcome };

/** What the previous turn left behind for the next user message. */
type Pending =
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "nudge"; text: string }
  | null;

/* ------------------------------------------------------------------ */
/* The loop                                                             */
/* ------------------------------------------------------------------ */

export async function runDiscovery(
  spec: DiscoverySpec,
  deps: { surface: WebSurface; policy: Policy; log: RunLogger; broker?: InterventionBroker },
): Promise<DiscoveryOutcome> {
  const { surface, policy, log, broker } = deps;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — the discovery loop calls the Anthropic API. " +
        "Export it and retry: export ANTHROPIC_API_KEY=sk-ant-...",
    );
  }
  const client = new Anthropic({ apiKey });
  const model = spec.model ?? process.env.MODEL ?? "claude-sonnet-4-5";
  const maxSteps = spec.maxSteps ?? 25;

  const recorder = new TraceRecorder();
  const extracted: Record<string, string> = {};
  const transcriptPath = path.join(log.dir, "transcript.jsonl");
  let stepsTaken = 0;

  /* ---- Evidence: redacted transcript --------------------------------- */
  // Two layers on purpose: exact sensitive input values are scrubbed first
  // (redactValue only knows the policy's generic patterns, not this run's
  // concrete secrets), then the policy's pattern redaction runs over the rest.
  const sensitiveValues = Object.entries(spec.inputs)
    .filter(
      ([name, input]) =>
        input.spec.sensitive ||
        policy.redaction.sensitiveParams.some((s) => name.toLowerCase().includes(s)),
    )
    .map(([, input]) => input.value)
    .filter((v) => v.length > 0);

  function scrubStrings(value: unknown): unknown {
    if (typeof value === "string") {
      let s = value;
      for (const v of sensitiveValues) s = s.split(v).join(MASK);
      return s;
    }
    if (Array.isArray(value)) return value.map(scrubStrings);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubStrings(v)]));
    }
    return value;
  }

  function writeTranscript(entry: Record<string, unknown>): void {
    const safe = redactValue(policy, scrubStrings({ ts: new Date().toISOString(), ...entry }));
    fs.appendFileSync(transcriptPath, JSON.stringify(safe) + "\n", "utf8");
  }

  /**
   * Terminal sweep over the persisted transcript: sensitive values discovered
   * MID-run (extracted outputs) must also vanish from lines written BEFORE we
   * knew them. Streaming writes keep crash-durability; this pass makes the
   * final file honest.
   */
  function finalizeTranscript(): void {
    try {
      const lines = fs.readFileSync(transcriptPath, "utf8");
      let out = lines;
      for (const v of sensitiveValues) out = out.split(JSON.stringify(v).slice(1, -1)).join(MASK);
      if (out !== lines) fs.writeFileSync(transcriptPath, out, "utf8");
    } catch {
      /* transcript may not exist on very early failures — nothing to sweep */
    }
  }

  /** Raw base64 never reaches the transcript — screenshots live in evidence PNGs. */
  function summarizeBlocks(blocks: ContentBlockParam[]): unknown[] {
    return blocks.map((b) => {
      switch (b.type) {
        case "image":
          return "[screenshot omitted]";
        case "text":
          return { type: "text", text: b.text };
        case "tool_use":
          return { type: "tool_use", name: b.name, input: b.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            is_error: b.is_error ?? false,
            content: b.content,
          };
        default:
          return { type: (b as { type: string }).type };
      }
    });
  }

  function readScreenshotBase64(p: string | undefined): string | undefined {
    if (!p) return undefined;
    try {
      return fs.readFileSync(p).toString("base64");
    } catch {
      log.event("agent.screenshot_unreadable", { path: p });
      return undefined;
    }
  }

  // Old screenshots are replaced by a text stub before each new turn: the
  // latest image is what grounds the next decision, and 25 turns of full-page
  // PNGs would blow the context window (and the budget) for no signal.
  function pruneOldScreenshots(history: Anthropic.Messages.MessageParam[]): void {
    for (const message of history) {
      if (message.role !== "user" || typeof message.content === "string") continue;
      message.content = message.content.map((b) =>
        b.type === "image"
          ? { type: "text" as const, text: "[screenshot from an earlier turn omitted]" }
          : b,
      );
    }
  }

  /* ---- Terminal outcomes ---------------------------------------------- */
  function endRun(status: "gave_up" | "escalated_abort"): DiscoveryOutcome {
    log.event("discovery.end", { status, stepsTaken });
    writeTranscript({ direction: "outcome", status, stepsTaken });
    finalizeTranscript();
    return { status, stepsTaken, transcriptPath };
  }

  /** Blocks until a human took control of the live session and handed it back. */
  async function raiseToHuman(
    b: InterventionBroker,
    reason: string,
    obs: Observation,
  ): Promise<InterventionOutcome> {
    log.event("intervention.raised", { reason });
    const outcome = await b.raise({
      reason,
      capabilityId: spec.capabilityId,
      goal: spec.goal,
      observedState: `Discovery paused on ${obs.url} ("${obs.title}")`,
      screenshotPath: obs.screenshotPath,
    });
    log.event("intervention.resolved", { disposition: outcome.disposition });
    return outcome;
  }

  /* ---- Tool handlers --------------------------------------------------- */

  /** Translate the model's act input into a typed DiscoveryAction (or a correction). */
  function toDiscoveryAction(input: ActInput): DiscoveryAction | string {
    switch (input.action) {
      case "navigate":
        return input.url ? { type: "navigate", url: input.url } : "navigate requires a url";
      case "click":
        return input.ref ? { type: "click", ref: input.ref } : "click requires a ref";
      case "fill":
        if (!input.ref) return "fill requires a ref";
        if (input.value === undefined) return "fill requires a value";
        return { type: "fill", ref: input.ref, value: input.value };
      case "select":
        if (!input.ref) return "select requires a ref";
        if (input.value === undefined) return "select requires a value";
        return { type: "select", ref: input.ref, value: input.value };
      case "press":
        if (!input.ref) return "press requires a ref";
        if (!input.key) return "press requires a key";
        return { type: "press", ref: input.ref, key: input.key };
    }
  }

  async function handleAct(input: ActInput, obs: Observation): Promise<HandlerResult> {
    const actionOrError = toDiscoveryAction(input);
    if (typeof actionOrError === "string") {
      return { kind: "feedback", content: `Invalid act call: ${actionOrError}.`, isError: true };
    }
    const action = actionOrError;

    // The single policy choke point — a violating action never touches the surface.
    const decision = enforce(policy, action, { currentUrl: obs.url, observation: obs });
    if (!decision.allow) {
      log.event("policy.refused", { action: action.type, risk: decision.risk, reason: decision.reason });
      if (decision.escalate) {
        if (!broker) {
          // Policy demands a human and there is none to ask — stop cleanly
          // rather than letting the model talk its way around the refusal.
          log.event("discovery.gave_up", { reason: `escalation required but no broker: ${decision.reason}` });
          return { kind: "terminal", outcome: endRun("gave_up") };
        }
        const intervention = await raiseToHuman(broker, decision.reason, obs);
        if (intervention.disposition === "aborted") {
          return { kind: "terminal", outcome: endRun("escalated_abort") };
        }
        // "resumed" or "completed_manually": the human acted on the SAME live
        // session — the next turn's fresh observation shows the result, and the
        // model decides whether to extract/finish from there.
        return {
          kind: "feedback",
          content:
            `A human operator handled this step (disposition: ${intervention.disposition}). ` +
            `Observe the fresh page state and continue toward the goal.`,
        };
      }
      return {
        kind: "feedback",
        content: `Policy refused the action: ${decision.reason}. Adjust your approach — do not repeat the same action.`,
        isError: true,
      };
    }

    // Deep-copy the element descriptors AT ACT TIME: refs are ephemeral, and
    // the compiler must see the element exactly as it was when acted upon.
    let element: ObservedElement | undefined;
    if ("ref" in action) {
      const found = obs.elements.find((e) => e.ref === action.ref);
      if (!found) {
        return {
          kind: "feedback",
          content: `Unknown ref "${action.ref}". Use a ref from the LATEST observation only.`,
          isError: true,
        };
      }
      element = structuredClone(found);
    }

    const preUrl = obs.url;
    try {
      await surface.actOnRef(action);
      await surface.settle();
    } catch (err) {
      const msg = errorMessage(err);
      log.event("agent.action_failed", { type: action.type, intent: input.intent, error: msg });
      return { kind: "feedback", content: `Action failed: ${msg}. Try a different element or route.`, isError: true };
    }
    const postUrl = await surface.location();
    recorder.record({ intent: input.intent, action, element, preUrl, postUrl });
    log.event("agent.action_executed", { type: action.type, intent: input.intent, preUrl, postUrl });
    return {
      kind: "feedback",
      content: `Done: ${action.type}${"ref" in action ? ` on ${action.ref}` : ""}. URL is now ${postUrl}.`,
    };
  }

  async function handleExtract(input: ExtractInput, obs: Observation): Promise<HandlerResult> {
    if (!(input.output in spec.outputs)) {
      const declared = Object.keys(spec.outputs).join(", ") || "(none)";
      return {
        kind: "feedback",
        content: `"${input.output}" is not a declared output. Declared outputs: ${declared}.`,
        isError: true,
      };
    }
    const action: DiscoveryAction = { type: "extract", ref: input.ref };
    const decision = enforce(policy, action, { currentUrl: obs.url, observation: obs });
    if (!decision.allow) {
      log.event("policy.refused", { action: "extract", risk: decision.risk, reason: decision.reason });
      return { kind: "feedback", content: `Policy refused the extract: ${decision.reason}.`, isError: true };
    }
    const found = obs.elements.find((e) => e.ref === input.ref);
    if (!found) {
      return {
        kind: "feedback",
        content: `Unknown ref "${input.ref}". Use a ref from the LATEST observation only.`,
        isError: true,
      };
    }
    const raw = await surface.readTextByRef(input.ref);
    if (raw === null || raw.trim() === "") {
      return {
        kind: "feedback",
        content: `No text could be read from ${input.ref}. Pick the element whose text contains the value.`,
        isError: true,
      };
    }
    const value = raw.trim();
    recorder.record({
      intent: input.intent,
      action,
      element: structuredClone(found),
      preUrl: obs.url,
      postUrl: obs.url,
      extracted: { output: input.output, rawText: raw },
    });
    extracted[input.output] = value;
    // A sensitive OUTPUT's value becomes a secret the moment we read it:
    // scrub it from every future transcript line, and finalizeTranscript()
    // sweeps the lines that were written before we knew it (page text in
    // earlier observations legitimately showed it).
    if (spec.outputs[input.output]?.sensitive && value.length > 0) {
      sensitiveValues.push(value);
      if (raw && raw !== value) sensitiveValues.push(raw);
    }
    log.event("agent.output_extracted", { output: input.output, intent: input.intent });
    // Feed the text back so the model can sanity-check what it captured.
    return { kind: "feedback", content: `Extracted ${input.output} = ${JSON.stringify(value)}.` };
  }

  function handleFinish(input: FinishInput): HandlerResult {
    const missing = Object.keys(spec.outputs).filter((k) => !(k in extracted));
    if (missing.length > 0) {
      return {
        kind: "feedback",
        content: `Cannot finish: outputs not yet extracted: ${missing.join(", ")}. Call extract for each of them first.`,
        isError: true,
      };
    }
    if (recorder.length === 0) {
      return {
        kind: "feedback",
        content: "Cannot finish: no actions were recorded, so there is no flow to compile into a capability.",
        isError: true,
      };
    }

    const version = nextVersion(CAPABILITIES_DIR, spec.capabilityId);
    const artifact = compileArtifact({
      spec,
      trace: recorder.trace(),
      policy,
      runId: log.runId,
      model,
      version,
    });
    fs.mkdirSync(CAPABILITIES_DIR, { recursive: true });
    const artifactPath = path.join(CAPABILITIES_DIR, `${spec.capabilityId}.v${version}.json`);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    log.event("artifact.written", {
      path: artifactPath,
      capability: spec.capabilityId,
      version,
      steps: artifact.steps.length,
      // The model's free-text summary quotes whatever it saw on screen —
      // including sensitive extracted values. Scrub with this run's secret
      // set; the logger's pattern redaction can't know run-specific values.
      summary: scrubStrings(input.summary) as string,
    });
    log.event("discovery.end", { status: "success", stepsTaken });
    writeTranscript({ direction: "outcome", status: "success", stepsTaken, artifactPath });
    finalizeTranscript();
    return {
      kind: "terminal",
      outcome: {
        status: "success",
        artifactPath,
        artifact,
        outputs: { ...extracted },
        stepsTaken,
        transcriptPath,
      },
    };
  }

  async function handleEscalate(input: EscalateInput, obs: Observation): Promise<HandlerResult> {
    log.event("agent.escalated", { reason: input.reason });
    if (!broker) {
      log.event("discovery.gave_up", { reason: `model escalated but no broker: ${input.reason}` });
      return { kind: "terminal", outcome: endRun("gave_up") };
    }
    const intervention = await raiseToHuman(broker, input.reason, obs);
    if (intervention.disposition === "aborted") {
      return { kind: "terminal", outcome: endRun("escalated_abort") };
    }
    return {
      kind: "feedback",
      content:
        `A human operator intervened (disposition: ${intervention.disposition}). ` +
        `Observe the fresh page state; extract any remaining outputs and finish if the goal is met.`,
    };
  }

  async function dispatchTool(
    toolUse: Anthropic.Messages.ToolUseBlock,
    obs: Observation,
  ): Promise<HandlerResult> {
    switch (toolUse.name) {
      case "act": {
        const parsed = ActInputSchema.safeParse(toolUse.input);
        if (!parsed.success) {
          return { kind: "feedback", content: `Invalid act input — ${zodIssues(parsed.error)}.`, isError: true };
        }
        return handleAct(parsed.data, obs);
      }
      case "extract": {
        const parsed = ExtractInputSchema.safeParse(toolUse.input);
        if (!parsed.success) {
          return { kind: "feedback", content: `Invalid extract input — ${zodIssues(parsed.error)}.`, isError: true };
        }
        return handleExtract(parsed.data, obs);
      }
      case "finish": {
        const parsed = FinishInputSchema.safeParse(toolUse.input);
        if (!parsed.success) {
          return { kind: "feedback", content: `Invalid finish input — ${zodIssues(parsed.error)}.`, isError: true };
        }
        return handleFinish(parsed.data);
      }
      case "escalate": {
        const parsed = EscalateInputSchema.safeParse(toolUse.input);
        if (!parsed.success) {
          return { kind: "feedback", content: `Invalid escalate input — ${zodIssues(parsed.error)}.`, isError: true };
        }
        return handleEscalate(parsed.data, obs);
      }
      default:
        return {
          kind: "feedback",
          content: `Unknown tool "${toolUse.name}" — use act, extract, finish, or escalate.`,
          isError: true,
        };
    }
  }

  /* ---- Conversation loop ------------------------------------------------ */

  const systemPrompt = buildSystemPrompt(spec);
  log.event("discovery.start", {
    capability: spec.capabilityId,
    appId: spec.appId,
    model,
    maxSteps,
    entrypoint: spec.entrypoint,
  });
  writeTranscript({ direction: "system", model, system: systemPrompt });

  const messages: Anthropic.Messages.MessageParam[] = [];
  let pending: Pending = null;

  while (stepsTaken < maxSteps) {
    const obs = await surface.observe({ screenshot: true });

    pruneOldScreenshots(messages);

    // Assemble this turn's user message: previous tool result (or the initial
    // task framing) + fresh observation text + fresh screenshot.
    const userContent: ContentBlockParam[] = [];
    if (pending?.type === "tool_result") {
      userContent.push({
        type: "tool_result",
        tool_use_id: pending.toolUseId,
        content: pending.content,
        is_error: pending.isError,
      });
    } else if (pending?.type === "nudge") {
      userContent.push({ type: "text", text: pending.text });
    } else {
      userContent.push({ type: "text", text: FIRST_TURN_FRAMING });
    }
    userContent.push({ type: "text", text: renderObservation(obs) });
    const screenshot = readScreenshotBase64(obs.screenshotPath);
    if (screenshot) {
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: screenshot },
      });
    }
    messages.push({ role: "user", content: userContent });
    writeTranscript({ direction: "request", turn: stepsTaken, url: obs.url, content: summarizeBlocks(userContent) });

    // tool_choice "any" + disable_parallel_tool_use encodes the protocol at
    // the API level: the model MUST reply with exactly one tool call.
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS,
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      messages,
    });
    stepsTaken += 1;

    // Re-shape response blocks into request params explicitly — keeps us
    // compatible across SDK versions that add new response block types.
    const assistantContent: ContentBlockParam[] = [];
    for (const b of response.content) {
      if (b.type === "text") assistantContent.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
    messages.push({ role: "assistant", content: assistantContent });
    writeTranscript({
      direction: "response",
      turn: stepsTaken - 1,
      stop_reason: response.stop_reason,
      usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
      content: summarizeBlocks(assistantContent),
    });
    log.event("model.turn", {
      turn: stepsTaken,
      stop_reason: response.stop_reason ?? "",
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse) {
      // Should not happen under tool_choice "any"; nudge instead of crashing.
      log.event("model.no_tool_call", { stop_reason: response.stop_reason ?? "" });
      pending = { type: "nudge", text: "Reply with exactly one tool call (act, extract, finish, or escalate)." };
      continue;
    }

    const result = await dispatchTool(toolUse, obs);
    if (result.kind === "terminal") return result.outcome;
    pending = { type: "tool_result", toolUseId: toolUse.id, content: result.content, isError: result.isError ?? false };
  }

  /* ---- Step budget exhausted -------------------------------------------- */
  log.event("discovery.max_steps", { maxSteps });
  if (broker) {
    const obs = await surface.observe({ screenshot: true });
    const intervention = await raiseToHuman(
      broker,
      `Discovery exceeded the ${maxSteps}-step budget without finishing`,
      obs,
    );
    if (intervention.disposition === "aborted") return endRun("escalated_abort");
    // Even if the human resumed/completed, the recording budget is spent and
    // the trace is partial — report gave_up so the caller re-runs with a
    // larger budget instead of trusting a half-recorded flow.
  }
  return endRun("gave_up");
}
