/**
 * Control-transfer model for human-in-the-loop handoff.
 *
 * Invariant: at any moment exactly one party controls the live session —
 * the automation ("agent") or a person ("human"). Transfers are explicit,
 * timestamped state transitions, never implicit:
 *
 *   agent --raise(intervention)--> paused (control offered)
 *   paused --operator takes control--> human
 *   human --operator hands back--> agent (resume | completed_manually | aborted)
 *
 * The executor blocks while control != agent; the surface session stays
 * alive throughout, so the human operates the SAME session the automation
 * was using, and automation resumes on it afterward.
 */
import type { InterventionRecord } from "../schema/result.js";

export type Controller = "agent" | "paused" | "human";

export interface ControlState {
  controller: Controller;
  since: string;                         // ISO timestamp of last transition
  interventionId?: string;
}

/** What automation hands to the broker when it cannot safely proceed. */
export interface InterventionRequest {
  reason: string;                        // why automation stopped (one line)
  capabilityId: string;
  goal: string;
  stepId?: string;
  observedState: string;                 // short description of what we see
  screenshotPath?: string;
}

/** How the human disposed of the intervention. */
export type Disposition = "resumed" | "completed_manually" | "aborted";

export interface InterventionOutcome {
  record: InterventionRecord;
  disposition: Disposition;
}

/**
 * The broker owns the control token and the operator-facing surface.
 * `raise` resolves only when a human has taken control, acted, and handed
 * control back (or aborted) — automation simply awaits it.
 */
export interface InterventionBroker {
  state(): ControlState;
  raise(req: InterventionRequest): Promise<InterventionOutcome>;
}
