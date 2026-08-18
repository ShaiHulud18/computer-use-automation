/**
 * Templating + input validation for deterministic replay.
 *
 * Artifacts never contain caller data — steps reference values as
 * `{{inputs.x}}` (caller-supplied, per-invocation) or `{{bindings.x}}`
 * (operator-configured, per-tenant). This module is the ONLY place those
 * placeholders are resolved, and it is deliberately dumb: no expressions,
 * no defaults, no nesting. Anything an LLM might have gotten creative with
 * at discovery time either resolves against a known table or the run stops
 * before touching the surface.
 */
import type { CapabilityArtifact } from "../schema/artifact.js";

/** Matches `{{ inputs.foo }}` / `{{bindings.bar}}` with optional inner whitespace. */
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface TemplateContext {
  inputs: Record<string, string>;
  bindings: Record<string, string>;
}

/**
 * Resolve every placeholder in `text`. Throws if any placeholder cannot be
 * resolved (unknown namespace or missing key) — an unresolved placeholder
 * means the artifact and its invocation disagree, and silently sending the
 * literal `{{inputs.x}}` string into a form field would corrupt real data.
 *
 * Deliberately SINGLE-PASS: substituted values are never re-scanned, so a
 * caller-supplied value that happens to contain `{{bindings.x}}` is treated
 * as opaque data, not as a template (no injection through inputs).
 */
export function substitute(
  text: string,
  ctx: { inputs: Record<string, string>; bindings: Record<string, string> },
): string {
  const unresolved: string[] = [];
  // Replacement via callback: avoids String.replace's `$`-pattern expansion,
  // so values containing "$&" etc. pass through verbatim.
  const out = text.replace(PLACEHOLDER, (whole, path: string) => {
    const dot = path.indexOf(".");
    const namespace = dot === -1 ? path : path.slice(0, dot);
    const key = dot === -1 ? "" : path.slice(dot + 1);
    const table =
      namespace === "inputs" ? ctx.inputs : namespace === "bindings" ? ctx.bindings : undefined;
    const value = table === undefined ? undefined : table[key];
    if (value === undefined) {
      unresolved.push(whole);
      return whole;
    }
    return value;
  });
  if (unresolved.length > 0) {
    throw new Error(`Unresolved template placeholder(s): ${unresolved.join(", ")}`);
  }
  return out;
}

/**
 * Validate caller-supplied inputs against the artifact's contract BEFORE any
 * browser action. The whole point of the contract is that bad invocations
 * fail fast and cheap (no session, no side effects), with errors a calling
 * agent can act on. Collects ALL problems instead of stopping at the first.
 *
 * Rules:
 *  - every required param must be present;
 *  - unknown keys are rejected (a typo'd param name silently ignored would
 *    surface later as a confusing unresolved-placeholder failure);
 *  - declared `pattern` regexes must match;
 *  - values are transport-typed as strings, but declared number/boolean
 *    params must at least parse as such.
 */
export function validateInputs(
  artifact: CapabilityArtifact,
  given: Record<string, string>,
): { ok: true; values: Record<string, string> } | { ok: false; errors: string[] } {
  const specs = artifact.contract.inputs;
  const errors: string[] = [];

  for (const key of Object.keys(given)) {
    if (!(key in specs)) {
      errors.push(`unknown input "${key}" — declared inputs: ${Object.keys(specs).join(", ") || "(none)"}`);
    }
  }

  const values: Record<string, string> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const raw = given[name];
    if (raw === undefined) {
      if (spec.required) errors.push(`missing required input "${name}" (${spec.description})`);
      continue; // optional and absent: fine — steps referencing it will fail loudly at substitution
    }
    if (spec.type === "number" && !/^-?\d+(\.\d+)?$/.test(raw)) {
      errors.push(`input "${name}" must be a number, got "${raw}"`);
    }
    if (spec.type === "boolean" && !/^(true|false)$/i.test(raw)) {
      errors.push(`input "${name}" must be "true" or "false", got "${raw}"`);
    }
    if (spec.pattern !== undefined) {
      let re: RegExp | undefined;
      try {
        re = new RegExp(spec.pattern);
      } catch {
        // A malformed pattern is an artifact defect; refuse to run rather
        // than skip validation and push unvetted data into a legacy system.
        errors.push(`input "${name}": artifact declares an invalid pattern regex: ${spec.pattern}`);
      }
      if (re !== undefined && !re.test(raw)) {
        errors.push(`input "${name}" does not match required pattern ${spec.pattern}`);
      }
    }
    values[name] = raw;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}
