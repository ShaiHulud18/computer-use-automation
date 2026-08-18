/**
 * Capability Artifact schema — the central data model of this system.
 *
 * A capability artifact is the durable, reviewable output of an LLM discovery
 * run: a typed, versioned description of a UI flow that an AI agent can invoke
 * as a capability, and that the replay engine can execute deterministically
 * with no model in the loop.
 *
 * Design principles:
 *  - CONTRACT-FIRST: `contract` declares what a caller supplies (inputs), what
 *    it gets back (outputs), and every legitimate business outcome. A calling
 *    agent (or human reviewer) can understand the capability from the contract
 *    alone, without reading the steps.
 *  - SEMANTIC-FIRST TARGETING: each step's target carries a ranked ladder of
 *    locator candidates, ordered by expected robustness, each with a recorded
 *    rationale. Semantic strategies (role/name/label/text) come first because
 *    they survive markup churn and generalize beyond the web (they map onto
 *    accessibility APIs on desktop surfaces too); structural CSS is a last
 *    resort and says so in its rationale.
 *  - DETECTORS ≠ STEPS: runtime conditions (validation errors, "not found",
 *    interstitials, session expiry) are declared as named detectors with an
 *    explicit classification — business outcome vs. recoverable vs. hard
 *    failure. The executor evaluates them at every step boundary, so handling
 *    exceptional states is a property of the artifact, not ad-hoc code.
 *  - NO SECRETS, NO TRANSCRIPT: steps reference inputs as `{{inputs.name}}`;
 *    concrete values are supplied per-invocation and never baked in. The raw
 *    model transcript stays in evidence; the artifact only records provenance.
 *  - SURFACE-AGNOSTIC CORE: nothing in the schema assumes a browser except the
 *    optional `css` locator strategy and `url` conditions, both clearly marked.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1.0";

/* ------------------------------------------------------------------ */
/* Targeting                                                           */
/* ------------------------------------------------------------------ */

/** One way of finding a control, with the recorded reason to trust it. */
export const LocatorCandidateSchema = z.discriminatedUnion("strategy", [
  // Accessibility-level strategies: preferred, portable across surfaces.
  z.object({
    strategy: z.literal("role"),
    role: z.string(),                    // ARIA/AX role, e.g. "textbox", "button"
    name: z.string(),                    // accessible name (exact match)
    rationale: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  }),
  z.object({
    strategy: z.literal("label"),        // form control resolved by its label text
    text: z.string(),
    rationale: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  }),
  z.object({
    strategy: z.literal("text"),         // visible text of the element itself
    text: z.string(),
    exact: z.boolean().default(true),
    rationale: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  }),
  z.object({
    strategy: z.literal("placeholder"),
    text: z.string(),
    rationale: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  }),
  // Structural fallback: web-only, brittle by nature — recorded last with a
  // rationale explaining why it is expected to hold for this app.
  z.object({
    strategy: z.literal("css"),
    selector: z.string(),
    rationale: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  }),
]);
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;

/** A target control: human-readable description + ranked locator ladder. */
export const TargetSpecSchema = z.object({
  description: z.string(),               // "Member ID search input"
  /** Frame path for legacy frameset/iframe apps; empty = main frame. */
  framePath: z.array(z.string()).default([]),
  /** Ranked candidates; replay tries them in order and logs which one won. */
  candidates: z.array(LocatorCandidateSchema).min(1),
});
export type TargetSpec = z.infer<typeof TargetSpecSchema>;

/* ------------------------------------------------------------------ */
/* Conditions & detectors                                              */
/* ------------------------------------------------------------------ */

export const ConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url_matches"), pattern: z.string() }),   // regex
  z.object({ kind: z.literal("text_visible"), pattern: z.string() }),  // regex, page text
  z.object({ kind: z.literal("element_visible"), target: TargetSpecSchema }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

/** Bounded, declarative recovery for `recoverable` detectors. */
export const RecoverySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dismiss"), target: TargetSpecSchema }), // click a known dismiss control
  z.object({ type: z.literal("reload_and_retry_step") }),
  z.object({
    type: z.literal("wait_retry"),
    times: z.number().int().min(1).max(5),
    delayMs: z.number().int().min(100).max(30_000),
  }),
]);
export type Recovery = z.infer<typeof RecoverySchema>;

/**
 * A named runtime condition and what it MEANS. This is where the error
 * taxonomy lives:
 *  - business_outcome: a legitimate result the caller must receive
 *    ("no such member" is an answer, not a crash).
 *  - recoverable: a known interstitial/transient; executor applies the bounded
 *    recovery and continues.
 *  - hard_failure: stop, capture evidence, surface a debuggable error.
 */
export const DetectorSchema = z.object({
  id: z.string(),
  description: z.string(),
  condition: ConditionSchema,
  /** Which steps this detector is checked after; "always" = every boundary. */
  appliesTo: z.union([z.literal("always"), z.array(z.string())]).default("always"),
  classification: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("business_outcome"), code: z.string() }),
    z.object({ kind: z.literal("recoverable"), recovery: RecoverySchema }),
    z.object({ kind: z.literal("hard_failure"), reason: z.string() }),
  ]),
});
export type Detector = z.infer<typeof DetectorSchema>;

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

/**
 * Step actions. Values may reference inputs/bindings with `{{inputs.x}}` /
 * `{{bindings.x}}` templates — never concrete caller data.
 */
export const StepActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string() }),
  z.object({ type: z.literal("click"), target: TargetSpecSchema }),
  z.object({ type: z.literal("fill"), target: TargetSpecSchema, value: z.string() }),
  z.object({ type: z.literal("select"), target: TargetSpecSchema, value: z.string() }),
  z.object({ type: z.literal("press"), target: TargetSpecSchema, key: z.string() }),
  /** Read text from a target and bind it to a declared output. */
  z.object({
    type: z.literal("extract"),
    target: TargetSpecSchema,
    output: z.string(),                  // must name a key in contract.outputs
    /** Optional regex with one capture group applied to the raw text. */
    parse: z.string().optional(),
  }),
]);
export type StepAction = z.infer<typeof StepActionSchema>;

export const StepSchema = z.object({
  id: z.string(),                        // stable, e.g. "s3-open-member"
  intent: z.string(),                    // human-readable purpose of the step
  action: StepActionSchema,
  /** What must be true before the step is considered settled. */
  wait: z
    .object({
      until: ConditionSchema.optional(), // default: surface's idle heuristic
      timeoutMs: z.number().int().default(10_000),
    })
    .default({ timeoutMs: 10_000 }),
  /** Assertion checked after wait; failing it triggers detector evaluation,
   *  and if no detector explains the state, a hard failure. */
  postcondition: ConditionSchema.optional(),
  /**
   * Risk class. "safe" = read/navigate/type (reversible pre-submit).
   * "risky" = commits state or is irreversible (final submits, confirms,
   * deletes, transfers). Policy decides how risky steps are handled.
   */
  risk: z.enum(["safe", "risky"]).default("safe"),
});
export type Step = z.infer<typeof StepSchema>;

/* ------------------------------------------------------------------ */
/* Contract (the agent-facing surface of the capability)               */
/* ------------------------------------------------------------------ */

export const ParamSpecSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  required: z.boolean().default(true),
  pattern: z.string().optional(),        // validation regex for strings
  example: z.string().optional(),        // safe, fake example only
  /** Sensitive values are masked in all logs/evidence (never persisted raw). */
  sensitive: z.boolean().default(false),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const OutputSpecSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  /** Sensitive outputs are returned to the caller but masked in logs. */
  sensitive: z.boolean().default(false),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const OutcomeSpecSchema = z.object({
  code: z.string(),                      // e.g. "MEMBER_NOT_FOUND"
  description: z.string(),
  detector: z.string(),                  // detector id that signals this outcome
});
export type OutcomeSpec = z.infer<typeof OutcomeSpecSchema>;

/* ------------------------------------------------------------------ */
/* The artifact                                                        */
/* ------------------------------------------------------------------ */

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),

  capability: z.object({
    id: z.string(),                      // stable slug, e.g. "lookup-member-balance"
    version: z.number().int().min(1),
    /** Unattended replay should be gated on "approved" (reviewable artifact). */
    status: z.enum(["draft", "approved"]),
    name: z.string(),
    description: z.string(),             // what it does, in caller terms
  }),

  /**
   * App identity — the multi-tenant seam. Artifacts bind to a vendor product
   * (appId), not a tenant. Tenant-specific values live in `bindings` and
   * `tenantOverrides`, so one artifact serves many institutions running the
   * same product.
   */
  app: z.object({
    appId: z.string(),                   // e.g. "legacy-cu-core"
    appVersionRange: z.string().optional(),
    surface: z.enum(["web", "desktop"]), // which Surface implementation drives it
  }),

  /**
   * Operator-configured, per-tenant values (vs. inputs = caller-supplied,
   * per-invocation). Steps reference them as {{bindings.x}}.
   */
  bindings: z.record(z.string()).default({}),

  /** Per-tenant specializations without re-recording: override bindings or
   *  swap a step's target ladder where a tenant's build differs. */
  tenantOverrides: z
    .record(
      z.object({
        bindings: z.record(z.string()).optional(),
        targets: z.record(TargetSpecSchema).optional(), // stepId -> replacement target
      }),
    )
    .default({}),

  contract: z.object({
    inputs: z.record(ParamSpecSchema),
    outputs: z.record(OutputSpecSchema),
    outcomes: z.array(OutcomeSpecSchema),
  }),

  steps: z.array(StepSchema).min(1),

  detectors: z.array(DetectorSchema),

  /** Final success condition — success is asserted, never assumed. */
  checkpoint: z.object({
    description: z.string(),
    conditions: z.array(ConditionSchema).min(1),
  }),

  /** Where this came from. Points at evidence; never contains transcript. */
  provenance: z.object({
    discoveredAt: z.string(),            // ISO timestamp
    model: z.string(),
    discoveryRunId: z.string(),
    evidenceRef: z.string(),             // path under /evidence
    goal: z.string(),                    // the original natural-language goal (redacted)
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

/** Parse + validate an artifact, with a readable error on failure. */
export function parseArtifact(json: unknown): CapabilityArtifact {
  const res = CapabilityArtifactSchema.safeParse(json);
  if (!res.success) {
    const issues = res.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid capability artifact:\n${issues}`);
  }
  return res.data;
}
