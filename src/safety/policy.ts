/**
 * Safety policy — an explicit, configurable allowlist plus a risk model.
 *
 * The policy is enforced in ONE choke point (`enforce`), called by both the
 * discovery loop and the replay executor before every action. The LLM never
 * gets a chance to act outside it: a violating action is refused before it
 * touches the surface, and the refusal is fed back to the model / reported
 * to the caller.
 *
 * Risk model: actions are classified safe vs risky. Risky = anything that
 * plausibly commits state we cannot revert from the outside (final submits,
 * confirms, deletes, transfers, approvals). Handling for risky actions is
 * configurable: "block" | "confirm" (require pre-approval flag) | "escalate"
 * (route to a human). Default is "escalate" — in a bank back-office, a person
 * decides, not the model.
 */
import { z } from "zod";
import type { StepAction } from "../schema/artifact.js";
import type { DiscoveryAction, Observation } from "../surface/types.js";

export const PolicySchema = z.object({
  /** URL prefixes the session may navigate to / act within. */
  allowedOrigins: z.array(z.string()).min(1),
  /** Action types the agent may perform at all. */
  allowedActions: z.array(
    z.enum(["navigate", "click", "fill", "select", "press", "extract"]),
  ),
  /** How to handle actions classified risky. */
  riskyActionHandling: z.enum(["block", "confirm", "escalate"]).default("escalate"),
  /**
   * Case-insensitive regexes matched against the accessible name / visible
   * text of click targets to classify them risky. Kept in config so tenants
   * can extend without code changes.
   */
  riskyPatterns: z
    .array(z.string())
    .default([
      "\\b(confirm|submit|approve|authorize)\\b",
      "\\b(delete|remove|close account)\\b",
      "\\b(transfer|withdraw|deposit|post|disburse)\\b",
      "\\bopen (sub-)?account\\b",
    ]),
  redaction: z
    .object({
      /** Param names whose values are always masked in logs/artifacts. */
      sensitiveParams: z.array(z.string()).default(["password", "ssn", "token", "secret", "pin"]),
      /** Value patterns masked anywhere they appear in logged text. */
      patterns: z
        .array(z.string())
        .default([
          "\\b\\d{3}-\\d{2}-\\d{4}\\b",          // SSN
          "\\b(?:\\d[ -]*?){13,19}\\b",           // card/account numbers (13-19 digits)
          "sk-[A-Za-z0-9-_]{10,}",                // API keys
        ]),
    })
    .default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

export type PolicyDecision =
  | { allow: true; risk: "safe" | "risky" }
  | { allow: false; risk: "safe" | "risky"; reason: string; escalate: boolean };

function originAllowed(policy: Policy, url: string): boolean {
  return policy.allowedOrigins.some((prefix) => url.startsWith(prefix));
}

/** Extract the pieces of an action the policy needs to judge it. */
function describeAction(
  action: StepAction | DiscoveryAction,
  obs?: Observation,
): { type: string; url?: string; targetText: string } {
  const type = action.type;
  let url: string | undefined;
  let targetText = "";
  if (action.type === "navigate") url = action.url;
  if ("ref" in action && obs) {
    const el = obs.elements.find((e) => e.ref === action.ref);
    if (el) targetText = `${el.name} ${el.descriptors.visibleText ?? ""}`;
  }
  if ("target" in action && action.target) {
    targetText = action.target.description +
      " " +
      action.target.candidates
        .map((c) => ("name" in c ? c.name : "text" in c ? c.text : ""))
        .join(" ");
  }
  return { type, url, targetText };
}

export function classifyRisk(
  policy: Policy,
  action: StepAction | DiscoveryAction,
  obs?: Observation,
): "safe" | "risky" {
  const { type, targetText } = describeAction(action, obs);
  if (type !== "click" && type !== "press") return "safe"; // typing/reading is pre-commit
  return policy.riskyPatterns.some((p) => new RegExp(p, "i").test(targetText))
    ? "risky"
    : "safe";
}

/**
 * The single enforcement choke point.
 * @param declaredRisk risk recorded on the artifact step (replay path) —
 *   the executor passes it so a step recorded as risky stays risky even if
 *   pattern matching would miss it.
 * @param confirmed caller passed an explicit approval flag for risky actions.
 */
export function enforce(
  policy: Policy,
  action: StepAction | DiscoveryAction,
  opts: {
    currentUrl: string;
    observation?: Observation;
    declaredRisk?: "safe" | "risky";
    confirmed?: boolean;
  },
): PolicyDecision {
  const { type, url } = describeAction(action, opts.observation);

  if (!policy.allowedActions.includes(type as Policy["allowedActions"][number])) {
    return { allow: false, risk: "safe", reason: `action type "${type}" is not in the allowlist`, escalate: false };
  }
  const effectiveUrl = url ?? opts.currentUrl;
  if (!originAllowed(policy, effectiveUrl)) {
    return { allow: false, risk: "safe", reason: `target "${effectiveUrl}" is outside allowed origins`, escalate: false };
  }

  const risk =
    opts.declaredRisk === "risky" ? "risky" : classifyRisk(policy, action, opts.observation);
  if (risk === "risky") {
    switch (policy.riskyActionHandling) {
      case "block":
        return { allow: false, risk, reason: "risky action blocked by policy", escalate: false };
      case "confirm":
        if (!opts.confirmed) {
          return {
            allow: false,
            risk,
            reason: "risky action requires explicit confirmation (--confirm-risky)",
            escalate: false,
          };
        }
        return { allow: true, risk };
      case "escalate":
        return { allow: false, risk, reason: "risky action requires a human decision", escalate: true };
    }
  }
  return { allow: true, risk };
}
