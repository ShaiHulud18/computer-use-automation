/**
 * Artifact compiler — turns a raw discovery trace into a reviewable, replayable
 * CapabilityArtifact.
 *
 * This is where a one-off session becomes a reusable capability:
 *  - concrete input values become {{inputs.*}} templates (never persisted raw),
 *  - the app origin becomes a {{bindings.origin}} tenant binding,
 *  - ephemeral element refs become ranked locator ladders,
 *  - observed URL transitions become explicit waits/postconditions,
 *  - and success becomes an asserted checkpoint, not an assumption.
 *
 * The compiler is deliberately pure w.r.t. the surface (it only reads the
 * trace) so it can be unit-tested without a browser, and it round-trips its
 * output through the zod schema so an artifact that would not parse can never
 * reach disk.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  DetectorSchema,
  SCHEMA_VERSION,
  parseArtifact,
  type CapabilityArtifact,
  type Condition,
  type Detector,
  type LocatorCandidate,
  type OutcomeSpec,
  type Step,
  type StepAction,
  type TargetSpec,
} from "../schema/artifact.js";
import { classifyRisk, type Policy } from "../safety/policy.js";
import { redactText } from "../util/redact.js";
import type { ObservedElement } from "../surface/types.js";
import type { TraceEntry } from "./recorder.js";
import type { DiscoverySpec } from "./loop.js";

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                   */
/* ------------------------------------------------------------------ */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bad tenant-config regexes must never crash compilation — treat as no-match. */
function safeRegexTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
}

/** Stable, readable step-id fragment: kebab-case intent capped at 24 chars. */
function kebab(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return slug === "" ? "step" : slug;
}

/* ------------------------------------------------------------------ */
/* App profile (detectors) loading                                      */
/* ------------------------------------------------------------------ */

/**
 * Detectors are app-level knowledge (validation errors, interstitials, session
 * expiry, hard errors), not per-capability knowledge — so they live in a
 * versionable per-app profile and every artifact for the app includes ALL of
 * them. Resolved relative to this module so cwd never matters.
 */
function loadAppDetectors(appId: string): Detector[] {
  const profilePath = fileURLToPath(new URL(`../../config/apps/${appId}.json`, import.meta.url));
  if (!fs.existsSync(profilePath)) {
    throw new Error(
      `App profile not found: ${profilePath}. Discovery needs config/apps/${appId}.json ` +
        `(a JSON array of detectors) to compile the artifact's detector set and outcome contract.`,
    );
  }
  const raw: unknown = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  // Accept both profile shapes: a bare DetectorSchema[] and the wrapped
  // { appId, detectors: [...] } form — tolerant reader, strict validator.
  const ProfileSchema = z.union([
    z.array(DetectorSchema),
    z
      .object({ detectors: z.array(DetectorSchema) })
      .passthrough()
      .transform((p) => p.detectors),
  ]);
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid app profile ${profilePath}:\n${issues}`);
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* The compiler                                                         */
/* ------------------------------------------------------------------ */

export function compileArtifact(args: {
  spec: DiscoverySpec;
  trace: TraceEntry[];
  policy: Policy;
  runId: string;
  model: string;
  /** Next version for this capability id — computed by the caller from the capabilities dir. */
  version: number;
}): CapabilityArtifact {
  const { spec, trace, policy, runId, model, version } = args;
  if (trace.length === 0) {
    throw new Error("compileArtifact: empty trace — there is no flow to compile");
  }

  /* ---- Phase 1: bindings -------------------------------------------- */
  // The origin is tenant configuration, not flow logic: one artifact must
  // serve many institutions running the same product at different hosts.
  const origin = new URL(spec.entrypoint).origin;
  const bindOrigin = (url: string): string =>
    url.startsWith(origin) ? `{{bindings.origin}}${url.slice(origin.length)}` : url;

  /* ---- Phase 2: parameterization ------------------------------------ */
  // Longest concrete value first so a value that contains another value
  // (e.g. "12345" inside "123456") can never be partially templated.
  const paramEntries = Object.entries(spec.inputs)
    .filter(([, v]) => v.value.length > 0)
    .sort((a, b) => b[1].value.length - a[1].value.length);

  // Applied to every string the artifact persists (action values, URLs,
  // locator texts, descriptions): the invariant is that no concrete caller
  // value ever survives into the artifact. URL-encoded forms are covered too,
  // because inputs frequently reappear inside query strings.
  const parameterize = (s: string): string => {
    let out = s;
    for (const [name, { value }] of paramEntries) {
      out = out.split(value).join(`{{inputs.${name}}}`);
      const encoded = encodeURIComponent(value);
      if (encoded !== value) out = out.split(encoded).join(`{{inputs.${name}}}`);
    }
    return out;
  };

  /* ---- Phase 4 helper: URL -> anchored regex pattern ----------------- */
  // Concrete input values inside the URL become wildcards BEFORE the rest of
  // the path is regex-escaped, so a replay with different inputs still
  // satisfies the wait/postcondition. The sentinel contains no regex
  // metacharacters, so it passes through escaping untouched.
  const SENTINEL = "\u0000PARAM\u0000";
  const urlPathPattern = (rawUrl: string): string => {
    const u = new URL(rawUrl);
    let pathAndQuery = u.pathname + u.search;
    for (const [, { value }] of paramEntries) {
      // Cover the value's URL spellings too: raw, percent-encoded (paths),
      // and plus-encoded (form GET query strings encode spaces as "+").
      const spellings = new Set([value, encodeURIComponent(value), value.split(" ").join("+")]);
      for (const spelling of spellings) {
        pathAndQuery = pathAndQuery.split(spelling).join(SENTINEL);
      }
    }
    const escaped = escapeRegExp(pathAndQuery).split(SENTINEL).join("[^/&]+");
    return `^${escaped}`;
  };

  /* ---- Phase 3: locator-ladder synthesis ----------------------------- */
  // Ranked by expected robustness. Semantic strategies first: they survive
  // markup churn and map onto accessibility APIs on desktop surfaces, which is
  // what keeps the artifact schema surface-agnostic. CSS is always LAST.
  // Deliberately NO dedupe: a role+name candidate and a text candidate with
  // identical strings resolve through different paths, and replay logs which
  // one won — that signal is how we monitor locator drift.
  const synthesizeTarget = (el: ObservedElement, extractedText?: string): TargetSpec => {
    const candidates: LocatorCandidate[] = [];
    // Data-vs-identity guard: when we EXTRACTED an element's text, that text
    // is the data we came for — a different invocation will render a different
    // value there. Encoding it as a role+name/text locator would be identity
    // theft by the data; skip those candidates and let the structural
    // fallback (whose path is stable in a fixed layout) carry the target.
    const isData = (t: string): boolean =>
      extractedText !== undefined && t.trim() === extractedText.trim();
    if (el.name.trim() !== "" && !isData(el.name)) {
      candidates.push({
        strategy: "role",
        role: el.role,
        name: parameterize(el.name),
        rationale:
          "accessible role+name; survives markup/layout changes and maps to a11y APIs on desktop surfaces",
        confidence: "high",
      });
    }
    if (el.descriptors.labelText) {
      candidates.push({
        strategy: "label",
        text: parameterize(el.descriptors.labelText),
        rationale: "explicit form label association; stable in this app",
        confidence: "high",
      });
    }
    if (el.descriptors.placeholder) {
      candidates.push({
        strategy: "placeholder",
        text: parameterize(el.descriptors.placeholder),
        rationale: "placeholder hint text; reasonably stable but cosmetic copy can change",
        confidence: "medium",
      });
    }
    const vis = el.descriptors.visibleText?.trim() ?? "";
    if (vis !== "" && vis.length <= 40 && !isData(vis)) {
      // Short visible text is a good signal for links/buttons; long text is
      // content, not identity, and would make an over-specific locator.
      candidates.push({
        strategy: "text",
        text: parameterize(vis),
        exact: true,
        rationale: "short exact visible text; effective for links/buttons but sensitive to copy edits",
        confidence: "medium",
      });
    }
    if (el.descriptors.cssPath) {
      candidates.push({
        strategy: "css",
        selector: el.descriptors.cssPath,
        rationale:
          "structural fallback captured from live DOM; brittle, used only if semantic candidates fail",
        confidence: "low",
      });
    }
    if (candidates.length === 0) {
      // Degenerate element with no usable descriptors — keep the artifact
      // schema-valid with an honest low-confidence role match rather than
      // failing the whole compilation.
      candidates.push({
        strategy: "role",
        role: el.role,
        name: el.name,
        rationale: "element exposed no usable descriptors at record time; role-only match as a last resort",
        confidence: "low",
      });
    }

    const label = el.name.trim() || el.descriptors.labelText || vis || el.role;
    // Same data-vs-identity rule for the human-readable description: an
    // extracted cell must not be described by the value it happened to hold
    // ("cell \"$4,521.19\"" bakes one member's balance — possibly sensitive —
    // into the artifact). Describe it by role instead.
    const safeLabel = isData(label) ? "(extracted value)" : `"${label}"`;
    return {
      // Describe the ELEMENT, never the intent: classifyRisk reads this
      // description, and intent phrasing like "submit member search" would
      // otherwise mark an innocent click risky and force escalation at replay.
      // The step's own `intent` field already records the why.
      description: parameterize(`${el.role} ${safeLabel}`),
      framePath: el.descriptors.framePath,
      candidates,
    };
  };

  const toStepAction = (entry: TraceEntry): StepAction => {
    const a = entry.action;
    if (a.type === "navigate") {
      return { type: "navigate", url: parameterize(bindOrigin(a.url)) };
    }
    const el = entry.element;
    if (!el) {
      throw new Error(
        `compileArtifact: trace entry ${entry.seq} (${a.type}) has no recorded element descriptor`,
      );
    }
    // For extract actions, tell the synthesizer which text is data so it
    // never becomes locator identity (see the data-vs-identity guard above).
    const target = synthesizeTarget(el, a.type === "extract" ? entry.extracted?.rawText : undefined);
    switch (a.type) {
      case "click":
        return { type: "click", target };
      case "press":
        return { type: "press", target, key: a.key };
      case "fill":
        return { type: "fill", target, value: parameterize(a.value) };
      case "select":
        return { type: "select", target, value: parameterize(a.value) };
      case "extract": {
        if (!entry.extracted) {
          throw new Error(`compileArtifact: extract entry ${entry.seq} has no output binding`);
        }
        return { type: "extract", target, output: entry.extracted.output };
      }
    }
  };

  /* ---- Phase 6: risk classification ---------------------------------- */
  // classifyRisk sees only the SYNTHESIZED target text; the raw recorded
  // descriptors are checked as well so a risky control cannot slip through a
  // lossy target description. The raw check is limited to click/press to stay
  // consistent with the policy's risk model (typing/reading is pre-commit) —
  // marking an extract or fill risky would force human escalation on reads.
  const stepRisk = (entry: TraceEntry, action: StepAction): "safe" | "risky" => {
    if (classifyRisk(policy, action) === "risky") return "risky";
    if ((action.type === "click" || action.type === "press") && entry.element) {
      const rawText = `${entry.element.name} ${entry.element.descriptors.visibleText ?? ""}`;
      if (policy.riskyPatterns.some((p) => safeRegexTest(p, rawText))) return "risky";
    }
    return "safe";
  };

  /* ---- Phases 3–6: steps --------------------------------------------- */
  const steps: Step[] = trace.map((entry) => {
    const action = toStepAction(entry);
    // Phase 4: a URL change is the strongest observable signal that the step
    // "landed" — assert it both as the wait condition and the postcondition so
    // replay failures are detected at the step that caused them.
    const changedUrl = entry.postUrl !== entry.preUrl;
    const until: Condition | undefined = changedUrl
      ? { kind: "url_matches", pattern: urlPathPattern(entry.postUrl) }
      : undefined;
    // Intents come from the model and routinely quote the concrete input
    // ("enter member id 12345...") — parameterize them like every other
    // persisted string so no caller value survives into ids or prose.
    const safeIntent = parameterize(entry.intent);
    return {
      id: `s${entry.seq}-${kebab(safeIntent)}`,
      intent: safeIntent,
      action,
      wait: until ? { until, timeoutMs: 10_000 } : { timeoutMs: 10_000 },
      postcondition: until,
      risk: stepRisk(entry, action),
    };
  });

  /* ---- Phase 7: detectors + declared outcomes ------------------------ */
  const detectors = loadAppDetectors(spec.appId);
  const outcomes: OutcomeSpec[] = detectors.flatMap((d) =>
    d.classification.kind === "business_outcome"
      ? [{ code: d.classification.code, description: d.description, detector: d.id }]
      : [],
  );

  /* ---- Phase 9: checkpoint ------------------------------------------- */
  // Success is asserted, never assumed: the final URL shape plus visibility of
  // the first extraction target (the strongest evidence the result screen
  // actually rendered data).
  const last = trace[trace.length - 1]!;
  const finalPattern = urlPathPattern(last.postUrl);
  const conditions: Condition[] = [{ kind: "url_matches", pattern: finalPattern }];
  const firstExtract = steps
    .map((s) => s.action)
    .find((a): a is Extract<StepAction, { type: "extract" }> => a.type === "extract");
  if (firstExtract) {
    conditions.push({ kind: "element_visible", target: firstExtract.target });
  }
  const checkpoint = {
    description: firstExtract
      ? `Flow complete: final URL matches ${finalPattern} and the "${firstExtract.output}" extraction target is visible.`
      : `Flow complete: final URL matches ${finalPattern}.`,
    conditions,
  };

  /* ---- Phases 8, 10: contract + identity + provenance ----------------- */
  // The goal is parameterized (concrete values -> templates) and pattern-
  // redacted before persisting: the artifact must carry zero caller data.
  const safeGoal = redactText(policy, parameterize(spec.goal));

  const candidate: CapabilityArtifact = {
    schemaVersion: SCHEMA_VERSION,
    capability: {
      id: spec.capabilityId,
      version,
      status: "draft", // unattended replay is gated on human review flipping this to "approved"
      name: spec.capabilityName,
      description: safeGoal,
    },
    app: { appId: spec.appId, surface: "web" },
    bindings: { origin },
    tenantOverrides: {},
    contract: {
      inputs: Object.fromEntries(Object.entries(spec.inputs).map(([k, v]) => [k, v.spec] as const)),
      outputs: spec.outputs,
      outcomes,
    },
    steps,
    detectors,
    checkpoint,
    provenance: {
      discoveredAt: new Date().toISOString(),
      model,
      discoveryRunId: runId,
      evidenceRef: "evidence/discovery-run",
      goal: safeGoal,
    },
  };

  /* ---- Phase 11: schema round-trip ------------------------------------ */
  // parseArtifact applies defaults and validates; an artifact that would not
  // parse can never be returned (and therefore never written to disk).
  return parseArtifact(candidate);
}
