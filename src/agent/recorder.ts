/**
 * Trace recorder — the bridge between "what the model did" and "what the
 * compiler can generalize".
 *
 * WHY a recorder instead of compiling on the fly: the discovery loop's job is
 * to get the flow done once; the compiler's job is to generalize it. Keeping a
 * flat, append-only trace between them means the compiler sees the complete
 * flow (needed for URL parameterization, final checkpoint synthesis, and the
 * extract-step targets) and the loop stays free of artifact concerns.
 *
 * Element descriptors are DEEP-COPIED at record time: `ObservedElement`s are
 * ephemeral views owned by the surface and their refs go stale after every
 * action. The compiler must see the descriptors exactly as they were at the
 * moment the action executed, not whatever the surface object mutates into.
 */
import type { DiscoveryAction, ObservedElement } from "../surface/types.js";

export interface TraceEntry {
  /** Monotonic sequence number; becomes part of the artifact step id. */
  seq: number;
  /** The model-supplied human phrase for WHY this action was taken. */
  intent: string;
  /** The concrete discovery-time action (ref-based; refs are NOT persisted usefully). */
  action: DiscoveryAction;
  /** Element descriptors captured at act time — locator-synthesis material. */
  element?: ObservedElement;
  /** URL before the action ran. */
  preUrl: string;
  /** URL after the action settled — preUrl !== postUrl drives wait synthesis. */
  postUrl: string;
  /** Present only for extract actions: which declared output the text bound to. */
  extracted?: { output: string; rawText: string };
  /** ISO timestamp of when the action was recorded. */
  at: string;
}

export class TraceRecorder {
  private readonly entries: TraceEntry[] = [];

  /** Append one successful action. Returns the completed entry (with seq/at). */
  record(entry: Omit<TraceEntry, "seq" | "at">): TraceEntry {
    const full: TraceEntry = {
      ...entry,
      // Defensive second copy: even if the caller forgot to clone, nothing
      // downstream can alias live surface state through the trace.
      element: entry.element ? structuredClone(entry.element) : undefined,
      seq: this.entries.length,
      at: new Date().toISOString(),
    };
    this.entries.push(full);
    return full;
  }

  get length(): number {
    return this.entries.length;
  }

  /** Immutable snapshot for the compiler — callers cannot mutate our history. */
  trace(): TraceEntry[] {
    return this.entries.map((e) => structuredClone(e));
  }
}
