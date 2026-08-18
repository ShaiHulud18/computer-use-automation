/**
 * Replay result contract — what a calling agent receives from an invocation.
 *
 * The taxonomy separates three things callers must never confuse:
 *  - success:           checkpoint verified, declared outputs returned.
 *  - business_outcome:  a legitimate, enumerated result of the flow
 *                       ("MEMBER_NOT_FOUND" is an answer, not an error).
 *  - hard_failure:      the flow could not be executed; carries step-level
 *                       diagnostics + evidence pointers for debugging.
 *  - intervention:      a human was (or must be) brought into the loop; the
 *                       result records why, and how it was resolved.
 *
 * Recoverable conditions (interstitials, transient slowness) are NOT terminal
 * statuses — they are handled during the run and reported in `recoveries` so
 * reliability trends stay visible without polluting the caller contract.
 */
import { z } from "zod";

export const RecoveryEventSchema = z.object({
  at: z.string(),                        // ISO timestamp
  stepId: z.string(),
  detectorId: z.string(),
  recovery: z.string(),                  // recovery type applied
  attempts: z.number().int(),
});
export type RecoveryEvent = z.infer<typeof RecoveryEventSchema>;

export const StepReportSchema = z.object({
  stepId: z.string(),
  intent: z.string(),
  status: z.enum(["ok", "recovered", "failed", "skipped", "human"]),
  /** Which locator candidate won (index + strategy), for drift monitoring. */
  locatorUsed: z.string().optional(),
  durationMs: z.number(),
});
export type StepReport = z.infer<typeof StepReportSchema>;

export const FailureDetailSchema = z.object({
  stepId: z.string(),
  stepIndex: z.number().int(),
  intent: z.string(),
  expected: z.string(),                  // what the step/postcondition required
  observed: z.string(),                  // what the surface actually showed
  evidence: z.array(z.string()),         // paths: screenshot, snapshot, log
});
export type FailureDetail = z.infer<typeof FailureDetailSchema>;

export const InterventionRecordSchema = z.object({
  id: z.string(),
  raisedAt: z.string(),
  reason: z.string(),                    // why automation stopped
  stepId: z.string().optional(),
  context: z.object({
    capabilityId: z.string(),
    goal: z.string(),
    screenshotPath: z.string().optional(),
    observedState: z.string(),
  }),
  /** Filled in when a human completed the handoff. */
  resolution: z
    .object({
      operator: z.string(),
      tookControlAt: z.string(),
      returnedControlAt: z.string(),
      humanActions: z.array(
        z.object({ at: z.string(), kind: z.string(), detail: z.string() }),
      ),
      disposition: z.enum(["resumed", "completed_manually", "aborted"]),
    })
    .optional(),
});
export type InterventionRecord = z.infer<typeof InterventionRecordSchema>;

export const ReplayResultSchema = z.object({
  runId: z.string(),
  capabilityId: z.string(),
  capabilityVersion: z.number().int(),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(["success", "business_outcome", "hard_failure", "intervention"]),

  /** Present on success. Sensitive outputs are masked in logs, not here. */
  outputs: z.record(z.string()).optional(),

  /** Present on business_outcome — one of the artifact's declared outcomes. */
  outcome: z.object({ code: z.string(), message: z.string() }).optional(),

  /** Present on hard_failure. */
  failure: FailureDetailSchema.optional(),

  /** Present when a human was pulled in. */
  intervention: InterventionRecordSchema.optional(),

  recoveries: z.array(RecoveryEventSchema),
  steps: z.array(StepReportSchema),
  evidenceDir: z.string(),
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;
