/**
 * Redaction — applied at the WRITE boundary of every log and artifact.
 * Nothing sensitive should depend on a caller remembering to redact; the
 * logger and artifact writer route all text through here.
 */
import type { Policy } from "../safety/policy.js";

const MASK = "▓▓REDACTED▓▓";

export function redactText(policy: Policy, text: string): string {
  let out = text;
  for (const p of policy.redaction.patterns) {
    try {
      out = out.replace(new RegExp(p, "g"), MASK);
    } catch {
      /* bad pattern in config — skip rather than crash the log path */
    }
  }
  return out;
}

/** Mask values of known-sensitive params and any param marked sensitive. */
export function redactParams(
  policy: Policy,
  params: Record<string, string>,
  sensitiveNames: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const isSensitive =
      sensitiveNames.has(k) ||
      policy.redaction.sensitiveParams.some((s) => k.toLowerCase().includes(s));
    out[k] = isSensitive ? MASK : redactText(policy, v);
  }
  return out;
}

/** Deep-redact any JSON-serializable value (for structured log payloads). */
export function redactValue<T>(policy: Policy, value: T): T {
  return JSON.parse(redactText(policy, JSON.stringify(value))) as T;
}
