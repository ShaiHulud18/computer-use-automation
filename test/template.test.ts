import { describe, expect, it } from "vitest";
import { parseArtifact } from "../src/schema/artifact.js";
import { substitute, validateInputs } from "../src/replay/template.js";

describe("template substitution", () => {
  const ctx = { inputs: { memberId: "12345" }, bindings: { origin: "http://localhost:4173" } };

  it("substitutes inputs and bindings", () => {
    expect(substitute("{{bindings.origin}}/search?mid={{inputs.memberId}}", ctx)).toBe(
      "http://localhost:4173/search?mid=12345",
    );
  });

  it("throws on unresolved placeholders instead of acting on garbage", () => {
    expect(() => substitute("{{inputs.missing}}", ctx)).toThrow(/missing/);
  });
});

describe("input validation against the contract", () => {
  const artifact = parseArtifact({
    schemaVersion: "1.0",
    capability: { id: "x", version: 1, status: "draft", name: "x", description: "d" },
    app: { appId: "legacy-cu-core", surface: "web" },
    bindings: {},
    tenantOverrides: {},
    contract: {
      inputs: { memberId: { type: "string", description: "id", required: true, pattern: "^\\d{5}$" } },
      outputs: {},
      outcomes: [],
    },
    steps: [
      {
        id: "s1",
        intent: "i",
        action: { type: "navigate", url: "{{bindings.origin}}/" },
      },
    ],
    detectors: [],
    checkpoint: { description: "c", conditions: [{ kind: "url_matches", pattern: "/" }] },
    provenance: {
      discoveredAt: "2026-08-18T00:00:00Z",
      model: "m",
      discoveryRunId: "r",
      evidenceRef: "e",
      goal: "g",
    },
  });

  it("accepts valid inputs", () => {
    const r = validateInputs(artifact, { memberId: "12345" });
    expect(r.ok).toBe(true);
  });

  it("rejects pattern violations as caller errors (before any UI action)", () => {
    const r = validateInputs(artifact, { memberId: "12ab" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/memberId/);
  });

  it("rejects missing required and unknown inputs", () => {
    expect(validateInputs(artifact, {}).ok).toBe(false);
    expect(validateInputs(artifact, { memberId: "12345", extra: "x" }).ok).toBe(false);
  });
});
