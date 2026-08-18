import { describe, expect, it } from "vitest";
import { CapabilityArtifactSchema, parseArtifact } from "../src/schema/artifact.js";

const minimalTarget = {
  description: "Member ID field",
  framePath: [],
  candidates: [
    { strategy: "label", text: "Member ID", rationale: "explicit form label", confidence: "high" },
    { strategy: "css", selector: "form input", rationale: "structural fallback", confidence: "low" },
  ],
};

const validArtifact = {
  schemaVersion: "1.0",
  capability: { id: "lookup-member-balance", version: 1, status: "draft", name: "Lookup member balance", description: "d" },
  app: { appId: "legacy-cu-core", surface: "web" },
  bindings: { origin: "http://localhost:4173" },
  tenantOverrides: {},
  contract: {
    inputs: { memberId: { type: "string", description: "5-digit member id", required: true, pattern: "^\\d{5}$", sensitive: false } },
    outputs: { savingsBalance: { type: "string", description: "current savings balance", sensitive: true } },
    outcomes: [{ code: "MEMBER_NOT_FOUND", description: "no such member", detector: "member-not-found" }],
  },
  steps: [
    {
      id: "s1-search",
      intent: "enter member id",
      action: { type: "fill", target: minimalTarget, value: "{{inputs.memberId}}" },
      wait: { timeoutMs: 10000 },
      risk: "safe",
    },
  ],
  detectors: [
    {
      id: "member-not-found",
      description: "results page shows no matches",
      condition: { kind: "text_visible", pattern: "No member records matched" },
      appliesTo: "always",
      classification: { kind: "business_outcome", code: "MEMBER_NOT_FOUND" },
    },
  ],
  checkpoint: { description: "on member record page", conditions: [{ kind: "url_matches", pattern: "/member" }] },
  provenance: {
    discoveredAt: "2026-08-18T00:00:00Z",
    model: "claude-sonnet-4-5",
    discoveryRunId: "discover-x",
    evidenceRef: "evidence/discovery-run",
    goal: "look up member and read savings balance",
  },
};

describe("capability artifact schema", () => {
  it("accepts a well-formed artifact and applies defaults", () => {
    const a = parseArtifact(validArtifact);
    expect(a.steps[0]?.wait.timeoutMs).toBe(10000);
    expect(a.contract.outputs.savingsBalance?.sensitive).toBe(true);
  });

  it("rejects concrete-value smells: steps must exist and targets need candidates", () => {
    const bad = structuredClone(validArtifact) as Record<string, unknown>;
    (bad.steps as unknown[]) = [];
    expect(() => parseArtifact(bad)).toThrow(/steps/);
  });

  it("produces readable, path-qualified validation errors", () => {
    const bad = structuredClone(validArtifact) as { detectors: { classification: { kind: string } }[] };
    bad.detectors[0]!.classification.kind = "nonsense";
    expect(() => parseArtifact(bad)).toThrow(/detectors\.0\.classification/);
  });

  it("round-trips through JSON (serializable, reviewable)", () => {
    const a = parseArtifact(validArtifact);
    const again = CapabilityArtifactSchema.parse(JSON.parse(JSON.stringify(a)));
    expect(again).toEqual(a);
  });
});
