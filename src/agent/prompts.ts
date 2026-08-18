/**
 * Prompt & tool-contract material for the discovery loop.
 *
 * WHY a separate file: for an LLM-driven system the prompt IS product surface.
 * Reviewing what the model is told (and what tools it may call) should not
 * require reading the loop mechanics. Everything the model "sees" — system
 * prompt, tool definitions, and the textual rendering of observations — is
 * defined here; loop.ts only wires it together.
 *
 * Tool inputs are validated twice on purpose: the JSON Schemas below constrain
 * the model at the API level (additionalProperties:false + required — strict),
 * and the zod schemas re-validate at runtime because model output is untrusted
 * input to our process no matter what the API promises.
 */
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Observation } from "../surface/types.js";
import type { DiscoverySpec } from "./loop.js";

/* ------------------------------------------------------------------ */
/* Tool input validation (runtime, zod)                                 */
/* ------------------------------------------------------------------ */

export const ActInputSchema = z
  .object({
    intent: z.string().min(1),
    action: z.enum(["click", "fill", "select", "press", "navigate"]),
    ref: z.string().optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();
export type ActInput = z.infer<typeof ActInputSchema>;

export const ExtractInputSchema = z
  .object({
    intent: z.string().min(1),
    ref: z.string().min(1),
    output: z.string().min(1),
  })
  .strict();
export type ExtractInput = z.infer<typeof ExtractInputSchema>;

export const FinishInputSchema = z.object({ summary: z.string().min(1) }).strict();
export type FinishInput = z.infer<typeof FinishInputSchema>;

export const EscalateInputSchema = z.object({ reason: z.string().min(1) }).strict();
export type EscalateInput = z.infer<typeof EscalateInputSchema>;

/* ------------------------------------------------------------------ */
/* Tool definitions (model-facing, strict JSON Schema)                  */
/* ------------------------------------------------------------------ */

export const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  {
    name: "act",
    description:
      "Perform exactly one UI action on the current page. Use a ref from the numbered element " +
      "list of the LATEST observation — refs from earlier turns are stale.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: {
          type: "string",
          description:
            'Short human phrase for WHY (recorded as the step intent), e.g. "submit member search".',
        },
        action: {
          type: "string",
          enum: ["click", "fill", "select", "press", "navigate"],
          description: "The kind of action to perform.",
        },
        ref: {
          type: "string",
          description: "Element ref from the latest observation (required for click/fill/select/press).",
        },
        value: {
          type: "string",
          description: "Text to type (fill), or the visible option label to choose (select).",
        },
        key: { type: "string", description: 'Keyboard key for press, e.g. "Enter".' },
        url: {
          type: "string",
          description: "Absolute URL for navigate; must stay inside the application origin.",
        },
      },
      required: ["intent", "action"],
    },
  },
  {
    name: "extract",
    description:
      "Read the text of one element and bind it to a declared output name. Every declared output " +
      "must be captured this way before finish.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: {
          type: "string",
          description: 'Short human phrase for WHY, e.g. "capture savings balance".',
        },
        ref: { type: "string", description: "Ref of the element whose text contains the value." },
        output: { type: "string", description: "The declared output name to bind the text to." },
      },
      required: ["intent", "ref", "output"],
    },
  },
  {
    name: "finish",
    description:
      "Declare the goal accomplished. Only valid after every declared output has been extracted.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", description: "One-paragraph summary of what was done." },
      },
      required: ["summary"],
    },
  },
  {
    name: "escalate",
    description:
      "Hand off to a human operator: you are stuck, or the flow requires a risky confirmation the " +
      "goal did not explicitly ask you to perform.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string", description: "Why automation cannot safely proceed." },
      },
      required: ["reason"],
    },
  },
];

/* ------------------------------------------------------------------ */
/* System prompt                                                        */
/* ------------------------------------------------------------------ */

export function buildSystemPrompt(spec: DiscoverySpec): string {
  const origin = new URL(spec.entrypoint).origin;
  const inputLines =
    Object.entries(spec.inputs)
      .map(([name, { value, spec: p }]) => `- ${name} = ${JSON.stringify(value)} — ${p.description}`)
      .join("\n") || "- (none)";
  const outputLines =
    Object.entries(spec.outputs)
      .map(([name, o]) => `- ${name}: ${o.description}`)
      .join("\n") || "- (none)";

  return `You are operating a legacy bank back-office web application through a browser, one action at a time.
Your job is to accomplish ONE specific goal, ONCE. Every action you take is being recorded and will be
compiled into a deterministic, replayable capability — so work cleanly: no exploration detours, no
redundant clicks, and use the most semantically meaningful controls available.

GOAL: ${spec.goal}

APP ENTRYPOINT: ${spec.entrypoint}
STAY WITHIN: ${origin} — never act on or navigate to any other site.

INPUT VALUES (use each value EXACTLY as written; they are parameterized during compilation, and any
reformatting or substitution breaks future replays):
${inputLines}

OUTPUTS YOU MUST CAPTURE (each via the \`extract\` tool, before calling \`finish\`):
${outputLines}

HOW EACH TURN WORKS:
- You receive the current page state: URL, title, a numbered element list, visible text, and a screenshot.
- Respond with EXACTLY ONE tool call (act, extract, finish, or escalate). Never respond with prose only.
- Element refs (e.g. "e7") are only valid for the LATEST observation; never reuse refs from earlier turns.

RULES:
1. Prefer labeled form fields and buttons/links with clear visible names over guessing by position.
2. Use the provided input values exactly as given; never invent, reformat, or substitute data.
3. Extract every declared output before finishing: pick the element whose text contains the value and
   call \`extract\` with the declared output name.
4. If a full-page "Scheduled Maintenance Notice" (or similar interstitial) appears, dismiss it with its
   button (e.g. "Acknowledge") and continue with the task.
5. If the same action fails twice in a row, do not try it a third time — choose a different element or a
   different route to the goal.
6. Every action is checked by a safety policy before it runs. If the policy refuses an action, read the
   refusal reason and adapt; do not repeat the refused action unchanged.
7. If you are truly stuck, or the flow demands a risky, state-committing confirmation (final submit,
   confirm, open account, transfer, delete) that the goal did NOT explicitly ask you to perform, call
   \`escalate\` with a clear reason instead of guessing.
8. Call \`finish\` only when the goal is met AND every declared output has been extracted.`;
}

/** Task kickoff line for the very first user turn (the system prompt carries the full framing). */
export const FIRST_TURN_FRAMING =
  "Discovery starts now. Below is the first observation of the application. Work toward the goal — reply with exactly one tool call.";

/* ------------------------------------------------------------------ */
/* Observation rendering                                                */
/* ------------------------------------------------------------------ */

// Caps keep per-turn token cost bounded on pathological pages; the screenshot
// carries anything the truncated text misses.
const MAX_ELEMENTS = 120;
const MAX_TEXT_CHARS = 4_000;
const MAX_FIELD_CHARS = 80;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Compact, line-oriented rendering of an observation. One line per element so
 * the model can cite refs unambiguously; JSON-quoted strings so whitespace and
 * empty names are visible.
 */
export function renderObservation(obs: Observation): string {
  const shown = obs.elements.slice(0, MAX_ELEMENTS);
  const lines = shown.map((el) => {
    const parts: string[] = [`[${el.ref}]`, el.role, JSON.stringify(clip(el.name, MAX_FIELD_CHARS))];
    if (el.value !== undefined && el.value !== "") {
      parts.push(`value=${JSON.stringify(clip(el.value, MAX_FIELD_CHARS))}`);
    }
    if (el.descriptors.labelText) {
      parts.push(`label=${JSON.stringify(clip(el.descriptors.labelText, MAX_FIELD_CHARS))}`);
    }
    if (el.descriptors.placeholder) {
      parts.push(`placeholder=${JSON.stringify(clip(el.descriptors.placeholder, MAX_FIELD_CHARS))}`);
    }
    const vis = el.descriptors.visibleText;
    if (vis && vis !== el.name) {
      parts.push(`text=${JSON.stringify(clip(vis, MAX_FIELD_CHARS))}`);
    }
    return parts.join(" ");
  });
  const omitted = obs.elements.length - shown.length;

  return [
    `URL: ${obs.url}`,
    `TITLE: ${obs.title}`,
    "",
    `ELEMENTS (${obs.elements.length}${omitted > 0 ? `; first ${MAX_ELEMENTS} shown` : ""}) — [ref] role "name" …:`,
    ...lines,
    "",
    "VISIBLE TEXT (truncated):",
    clip(obs.visibleText, MAX_TEXT_CHARS),
  ].join("\n");
}
