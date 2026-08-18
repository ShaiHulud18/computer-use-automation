import { describe, expect, it } from "vitest";
import { PolicySchema } from "../src/safety/policy.js";
import { redactParams, redactText, redactValue } from "../src/util/redact.js";

const policy = PolicySchema.parse({
  allowedOrigins: ["http://localhost:4173"],
  allowedActions: ["navigate"],
});

describe("redaction at the write boundary", () => {
  it("masks SSNs, card-like numbers, and API keys in free text", () => {
    const out = redactText(policy, "ssn 123-45-6789 card 4111 1111 1111 1111 key sk-ant-abc123def456ghi");
    expect(out).not.toContain("123-45-6789");
    expect(out).not.toContain("4111 1111 1111 1111");
    expect(out).not.toContain("sk-ant-abc123def456ghi");
  });

  it("masks sensitive params by name and by spec", () => {
    const out = redactParams(policy, { memberId: "12345", password: "hunter2", note: "ok" }, new Set(["note"]));
    expect(out.memberId).toBe("12345");
    expect(out.password).not.toContain("hunter2");
    expect(out.note).not.toBe("ok");
  });

  it("deep-redacts structured payloads", () => {
    const out = redactValue(policy, { nested: { ssn: "987-65-4321" }, list: ["123-45-6789"] });
    expect(JSON.stringify(out)).not.toContain("987-65-4321");
    expect(JSON.stringify(out)).not.toContain("123-45-6789");
  });

  it("survives a bad regex in config instead of crashing the log path", () => {
    const broken = PolicySchema.parse({
      allowedOrigins: ["http://localhost:4173"],
      allowedActions: ["navigate"],
      redaction: { sensitiveParams: [], patterns: ["([unclosed"] },
    });
    expect(() => redactText(broken, "hello")).not.toThrow();
  });
});
