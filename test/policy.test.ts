import { describe, expect, it } from "vitest";
import { PolicySchema, classifyRisk, enforce } from "../src/safety/policy.js";

const policy = PolicySchema.parse({
  allowedOrigins: ["http://localhost:4173"],
  allowedActions: ["navigate", "click", "fill", "select", "press", "extract"],
  riskyActionHandling: "escalate",
});

const target = (desc: string, name: string) => ({
  description: desc,
  framePath: [],
  candidates: [
    { strategy: "role" as const, role: "button", name, rationale: "r", confidence: "high" as const },
  ],
});

describe("policy allowlist", () => {
  it("refuses navigation outside allowed origins", () => {
    const d = enforce(policy, { type: "navigate", url: "https://evil.example/steal" }, { currentUrl: "http://localhost:4173/" });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/outside allowed origins/);
  });

  it("refuses actions when current location is off-origin", () => {
    const d = enforce(policy, { type: "click", target: target("x", "Search Records") }, { currentUrl: "https://elsewhere.example/" });
    expect(d.allow).toBe(false);
  });

  it("refuses disallowed action types", () => {
    const narrow = PolicySchema.parse({ allowedOrigins: ["http://localhost:4173"], allowedActions: ["navigate", "extract"] });
    const d = enforce(narrow, { type: "click", target: target("x", "View Record") }, { currentUrl: "http://localhost:4173/" });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/not in the allowlist/);
  });

  it("allows a plain in-origin click", () => {
    const d = enforce(policy, { type: "click", target: target("View link", "View Record") }, { currentUrl: "http://localhost:4173/search" });
    expect(d.allow).toBe(true);
    expect(d.risk).toBe("safe");
  });
});

describe("risk classification", () => {
  it("classifies confirm/submit style clicks as risky", () => {
    expect(classifyRisk(policy, { type: "click", target: target("confirm", "Confirm Account Opening") })).toBe("risky");
    expect(classifyRisk(policy, { type: "click", target: target("t", "Transfer Funds") })).toBe("risky");
  });

  it("treats typing and reading as safe (pre-commit)", () => {
    expect(classifyRisk(policy, { type: "fill", target: target("field", "Confirm Account Opening"), value: "x" })).toBe("safe");
    expect(classifyRisk(policy, { type: "extract", target: target("cell", "Savings"), output: "o" })).toBe("safe");
  });

  it("escalates risky actions under the default policy", () => {
    const d = enforce(policy, { type: "click", target: target("confirm", "Confirm Account Opening") }, { currentUrl: "http://localhost:4173/x" });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.escalate).toBe(true);
  });

  it("honors declaredRisk from the artifact even when patterns would miss it", () => {
    const d = enforce(policy, { type: "click", target: target("innocuous", "OK") }, { currentUrl: "http://localhost:4173/x", declaredRisk: "risky" });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.risk).toBe("risky");
  });

  it("confirm mode allows risky actions only with explicit confirmation", () => {
    const confirming = PolicySchema.parse({ ...policy, riskyActionHandling: "confirm" });
    const refused = enforce(confirming, { type: "click", target: target("c", "Confirm Account Opening") }, { currentUrl: "http://localhost:4173/x" });
    expect(refused.allow).toBe(false);
    const allowed = enforce(confirming, { type: "click", target: target("c", "Confirm Account Opening") }, { currentUrl: "http://localhost:4173/x", confirmed: true });
    expect(allowed.allow).toBe(true);
  });
});
