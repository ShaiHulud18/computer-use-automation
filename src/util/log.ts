/**
 * Structured run logger — JSONL, one event per line, redaction enforced at
 * the write boundary. Every run (discovery or replay) gets its own directory:
 *   runs/<runId>/log.jsonl        structured events
 *   runs/<runId>/*.png|*.html     evidence snapshots
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Policy } from "../safety/policy.js";
import { redactValue } from "./redact.js";

export interface RunLogger {
  runId: string;
  dir: string;
  event(kind: string, data?: Record<string, unknown>): void;
  child(prefix: string): (kind: string, data?: Record<string, unknown>) => void;
}

export function newRunId(prefix: string): string {
  const t = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${t}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createRunLogger(policy: Policy, runId: string, baseDir = "runs"): RunLogger {
  const dir = path.resolve(baseDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "log.jsonl");
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  function event(kind: string, data: Record<string, unknown> = {}): void {
    const entry = redactValue(policy, { ts: new Date().toISOString(), runId, kind, ...data });
    stream.write(JSON.stringify(entry) + "\n");
    // Console mirror: keep it human-scannable.
    const summary = Object.entries(data)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => `${k}=${String(v).slice(0, 120)}`)
      .join(" ");
    console.log(`[${kind}] ${redactValue(policy, summary)}`);
  }

  return {
    runId,
    dir,
    event,
    child: (prefix) => (kind, data) => event(`${prefix}.${kind}`, data),
  };
}
