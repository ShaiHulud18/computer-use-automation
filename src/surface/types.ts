/**
 * Surface abstraction — the seam between "the recorded flow" and "how we
 * perceive/act on a concrete UI technology".
 *
 * Everything above this interface (agent loop, recorder, replay executor,
 * escalation) speaks in terms of observations, semantic actions, targets and
 * conditions. Everything below it (Playwright today; a desktop accessibility
 * driver or screenshot+coordinates driver tomorrow) implements perception and
 * action for one technology.
 *
 * The contract is deliberately accessibility-shaped: roles, names, labels,
 * visible text. Those concepts exist on every surface we care about (web DOM,
 * legacy web via frames, Windows UIA / macOS AX for desktop), which is what
 * lets one artifact schema span heterogeneous apps.
 */
import type { Condition, StepAction, TargetSpec } from "../schema/artifact.js";

/** One interactive (or extractable) element as perceived on the surface. */
export interface ObservedElement {
  /** Ephemeral handle valid for the current observation only (e.g. "e12"). */
  ref: string;
  role: string;                          // accessibility role
  name: string;                          // accessible name ("" if none)
  value?: string;                        // current value for inputs
  /** Extra descriptors captured for locator synthesis at recording time. */
  descriptors: {
    labelText?: string;
    placeholder?: string;
    visibleText?: string;
    framePath: string[];
    /** Structural CSS path — last-resort fallback material, web only. */
    cssPath?: string;
  };
  boundingBox?: { x: number; y: number; width: number; height: number };
}

/** What the agent (or executor) can see right now. */
export interface Observation {
  url: string;
  title: string;
  /** Flattened, numbered inventory of actionable/readable elements. */
  elements: ObservedElement[];
  /** Full visible text of the page/screen (for outcome detection & the LLM). */
  visibleText: string;
  screenshotPath?: string;               // written under the run's evidence dir
}

/** Discovery-time actions reference observed elements by ephemeral ref. */
export type DiscoveryAction =
  | { type: "navigate"; url: string }
  | { type: "click"; ref: string }
  | { type: "fill"; ref: string; value: string }
  | { type: "select"; ref: string; value: string }
  | { type: "press"; ref: string; key: string }
  | { type: "extract"; ref: string };    // read text content of an element

export interface EvidenceSnapshot {
  screenshotPath: string;
  /** Structural snapshot (serialized DOM or AX tree) for post-mortem. */
  structurePath: string;
}

/** An action a human operator performed during a handoff (for the record). */
export interface HumanAction {
  at: string;                            // ISO timestamp
  kind: string;                          // "click" | "fill" | "navigate" | ...
  detail: string;                        // human-readable description (redacted)
}

/**
 * A live application surface. One instance == one live session; the same
 * instance is shared by automation and a human operator during handoff
 * (that is the point — escalation transfers control of THIS session).
 */
export interface Surface {
  readonly kind: "web" | "desktop";

  /** Perceive current state. Writes screenshot into the run evidence dir. */
  observe(opts?: { screenshot?: boolean }): Promise<Observation>;

  /** Discovery path: act on an element observed in the LAST observation. */
  actOnRef(action: DiscoveryAction): Promise<void>;

  /**
   * Replay path: resolve a recorded target via its locator ladder.
   * Returns the winning candidate index, or null if nothing resolved.
   * MUST be side-effect free.
   */
  resolveTarget(target: TargetSpec): Promise<{ candidateIndex: number } | null>;

  /** Replay path: execute a recorded step action (targets resolved via ladder). */
  act(action: StepAction): Promise<void>;

  /** Evaluate a declarative condition against current state. */
  check(condition: Condition): Promise<boolean>;

  /** Read text content of a target (for `extract` steps). */
  readText(target: TargetSpec): Promise<string | null>;

  /** Capture failure evidence (screenshot + structure dump). */
  captureEvidence(tag: string): Promise<EvidenceSnapshot>;

  /** Current location (URL for web; window/screen id for desktop). */
  location(): Promise<string>;

  /** Wait for the surface's own "settled" heuristic (network/paint idle). */
  settle(timeoutMs?: number): Promise<void>;

  /**
   * Handoff support: while a human controls the live session, record what
   * they do (clicks, typing, navigation) so the intervention record is
   * auditable. Values typed by the human are redacted, never stored raw.
   */
  startHumanRecording(): Promise<void>;
  stopHumanRecording(): Promise<HumanAction[]>;

  close(): Promise<void>;
}
