/**
 * OperatorBroker — the human-in-the-loop control-transfer broker plus a
 * deliberately minimal operator surface.
 *
 * What this module IS: the owner of the control token defined in
 * `hitl/types.ts` (agent -> paused -> human -> agent), a tiny HTTP console a
 * person uses to claim and return that token, and the scribe that turns each
 * handoff into an auditable `InterventionRecord`.
 *
 * What this module IS NOT: an executor. The broker knows NOTHING about steps,
 * artifacts, detectors or replay semantics — it brokers control of a live
 * session and records what happened while a human held it. Keeping that
 * boundary hard is what lets the same broker serve discovery, replay, or any
 * future caller without change.
 *
 * Control-transfer model (the important part — the UI is intentionally dumb):
 *  - raise() flips the token to "paused" and BLOCKS the caller until a human
 *    disposes of the intervention (or the auto-abort deadline fires). The
 *    executor does not poll; it simply awaits.
 *  - "Take control" does not proxy input through the broker. The human drives
 *    THE SAME live browser session automation was using (headed during demos);
 *    the broker only transfers the token and asks the surface to record what
 *    the human does for the audit trail.
 *  - Hand-back returns the token to "agent" with an explicit disposition, so
 *    the caller knows whether to resume, treat the task as done, or abort.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { InterventionRecord } from "../schema/result.js";
import type { HumanAction, Surface } from "../surface/types.js";
import type { RunLogger } from "../util/log.js";
import type {
  ControlState,
  Controller,
  Disposition,
  InterventionBroker,
  InterventionOutcome,
  InterventionRequest,
} from "./types.js";

export interface BrokerOptions {
  surface: Surface;
  log: RunLogger;
  /** Operator console port. Default 5111. */
  port?: number;
  /**
   * How long a raised intervention may sit unclaimed before the broker
   * auto-aborts it. Automation must never hang forever waiting for a human
   * who is not coming. Default 10 minutes.
   */
  autoAbortMs?: number;
}

/** Book-keeping for the single in-flight intervention. */
interface ActiveIntervention {
  id: string;
  raisedAt: string;
  req: InterventionRequest;
  screenshotPath?: string;
  /** Set by POST /take; absence means nobody ever claimed the seat. */
  operator?: string;
  tookControlAt?: string;
  autoAbortTimer?: NodeJS.Timeout;
  /** Resolves the promise the executor is awaiting in raise(). */
  resolve: (outcome: InterventionOutcome) => void;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Everything shown on the console page is data, not markup. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Collect a small urlencoded form body; the console never posts more. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > 64 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** POST handlers answer 303 -> / so a browser refresh never re-submits. */
function seeOther(res: http.ServerResponse): void {
  res.writeHead(303, { Location: "/" });
  res.end();
}

export class OperatorBroker implements InterventionBroker {
  private readonly opts: BrokerOptions;
  private readonly port: number;
  private readonly autoAbortMs: number;

  private control: ControlState;
  private active?: ActiveIntervention;
  /**
   * Serialization of raise() calls. One live session means one operator seat:
   * a second escalation cannot be meaningfully offered while a human may be
   * mid-handoff on the same browser, so later raises simply wait their turn.
   */
  private queueTail: Promise<void> = Promise.resolve();
  private seq = 0;

  /** Lazy-started on first raise; undefined result = start failed (degraded). */
  private serverReady?: Promise<http.Server | undefined>;
  private closed = false;

  /** interventionId -> screenshot path; the ONLY files the console serves,
   *  so there is no path-traversal surface on GET /screenshot-*.png. */
  private readonly screenshots = new Map<string, string>();

  constructor(opts: BrokerOptions) {
    this.opts = opts;
    this.port = opts.port ?? 5111;
    this.autoAbortMs = opts.autoAbortMs ?? 10 * 60 * 1000;
    this.control = { controller: "agent", since: new Date().toISOString() };
  }

  state(): ControlState {
    // Copy so callers cannot mutate the token from outside.
    return { ...this.control };
  }

  raise(req: InterventionRequest): Promise<InterventionOutcome> {
    const turn = this.queueTail.then(() => this.runIntervention(req));
    // Keep the queue alive whether a turn resolves or rejects.
    this.queueTail = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  /** Idempotent shutdown; also releases any caller still awaiting raise(). */
  async close(): Promise<void> {
    this.closed = true;
    // A closed broker must not leave the executor hanging — same guarantee
    // as auto-abort, just triggered by teardown instead of a deadline.
    await this.finishIntervention({
      disposition: "aborted",
      operatorOverride: "system:broker-closed",
    });
    const ready = this.serverReady;
    this.serverReady = undefined;
    const server = ready ? await ready : undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // The console page's meta refresh keeps keep-alive sockets open;
        // without this, close() would stall until they time out.
        server.closeAllConnections();
      });
      this.opts.log.event("hitl.server_stopped", { port: this.port });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Intervention lifecycle                                              */
  /* ------------------------------------------------------------------ */

  private async runIntervention(req: InterventionRequest): Promise<InterventionOutcome> {
    const id = `intv-${++this.seq}-${Math.random().toString(36).slice(2, 8)}`;
    const raisedAt = new Date().toISOString();

    if (this.closed) {
      // Teardown raced a queued escalation: synthesize an aborted outcome
      // instead of hanging or throwing mid-shutdown.
      const record = this.buildRecord({ id, raisedAt, req }, {
        operator: "system:broker-closed",
        tookControlAt: raisedAt,
        returnedControlAt: raisedAt,
        humanActions: [],
        disposition: "aborted",
      });
      this.writeInterventionFile(record);
      this.opts.log.event("hitl.raise_after_close", { interventionId: id, reason: req.reason });
      return { record, disposition: "aborted" };
    }

    this.setController("paused", id);
    // Full request goes through the RunLogger, which redacts at the write
    // boundary — the broker never needs to know what is sensitive.
    this.opts.log.event("hitl.raised", { interventionId: id, ...req });

    let screenshotPath = req.screenshotPath;
    if (!screenshotPath) {
      try {
        screenshotPath = (await this.opts.surface.captureEvidence(`intervention-${id}`))
          .screenshotPath;
      } catch (err) {
        // Evidence is best-effort: a broken screenshotter must not prevent
        // the human handoff that might rescue the run.
        this.opts.log.event("hitl.evidence_error", { interventionId: id, error: String(err) });
      }
    }
    if (screenshotPath) this.screenshots.set(id, screenshotPath);

    // Persist the pending intervention immediately (no resolution yet) so a
    // crash mid-handoff still leaves a record of why automation stopped.
    this.writeInterventionFile(this.buildRecord({ id, raisedAt, req, screenshotPath }));

    await this.ensureServer();
    this.printBanner(req);

    return new Promise<InterventionOutcome>((resolve) => {
      const act: ActiveIntervention = { id, raisedAt, req, screenshotPath, resolve };
      // The deadline only guards the UNCLAIMED state: once a human takes the
      // seat we cancel it — a person actively working gets as long as needed.
      act.autoAbortTimer = setTimeout(() => {
        this.opts.log.event("hitl.auto_abort", { interventionId: id, afterMs: this.autoAbortMs });
        void this.finishIntervention({
          disposition: "aborted",
          operatorOverride: "system:auto-abort",
        });
      }, this.autoAbortMs);
      this.active = act;
    });
  }

  /**
   * Single exit path for an intervention (handback, auto-abort, close).
   * Idempotent under races: whichever caller grabs `active` first wins.
   */
  private async finishIntervention(opts: {
    disposition?: Disposition;
    operatorOverride?: string;
  }): Promise<void> {
    const act = this.active;
    if (!act) return;
    this.active = undefined;
    if (act.autoAbortTimer) clearTimeout(act.autoAbortTimer);

    const returnedControlAt = new Date().toISOString();
    const tookControl = act.tookControlAt !== undefined;

    let humanActions: HumanAction[] = [];
    if (tookControl) {
      try {
        humanActions = await this.opts.surface.stopHumanRecording();
      } catch (err) {
        // The recording is audit evidence, not a gate: a recorder fault must
        // not block returning control to automation.
        this.opts.log.event("hitl.recording_error", { phase: "stop", error: String(err) });
      }
    }

    // No explicit disposition can only mean the seat was never properly worked
    // (auto-abort, teardown, or a bare handback while still paused). The only
    // defensible default is "aborted": nothing was done, so neither "resumed"
    // nor "completed_manually" can be assumed. An explicitly chosen
    // disposition still wins — an operator may legitimately click "resume"
    // without taking control, e.g. to push automation past a false alarm.
    const disposition: Disposition = opts.disposition ?? "aborted";
    const operator = opts.operatorOverride ?? act.operator ?? "operator:unidentified";

    const record = this.buildRecord(act, {
      operator,
      // Never-took-control edge: record a zero-length hold at return time.
      tookControlAt: act.tookControlAt ?? returnedControlAt,
      returnedControlAt,
      humanActions,
      disposition,
    });
    this.writeInterventionFile(record);
    this.setController("agent");
    this.opts.log.event("hitl.handback", {
      interventionId: act.id,
      disposition,
      operator,
      tookControl,
      humanActionCount: humanActions.length,
    });
    act.resolve({ record, disposition });
  }

  private buildRecord(
    base: { id: string; raisedAt: string; req: InterventionRequest; screenshotPath?: string },
    resolution?: InterventionRecord["resolution"],
  ): InterventionRecord {
    return {
      id: base.id,
      raisedAt: base.raisedAt,
      reason: base.req.reason,
      stepId: base.req.stepId,
      context: {
        capabilityId: base.req.capabilityId,
        goal: base.req.goal,
        screenshotPath: base.screenshotPath,
        observedState: base.req.observedState,
      },
      resolution,
    };
  }

  private setController(controller: Controller, interventionId?: string): void {
    this.control = { controller, since: new Date().toISOString(), interventionId };
  }

  /** The record lives beside the run log so one directory tells the story. */
  private writeInterventionFile(record: InterventionRecord): void {
    const file = path.join(this.opts.log.dir, `intervention-${record.id}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
    } catch (err) {
      this.opts.log.event("hitl.intervention_write_error", { file, error: String(err) });
    }
  }

  private get operatorUrl(): string {
    return `http://localhost:${this.port}/`;
  }

  private printBanner(req: InterventionRequest): void {
    // Deliberate exception to "all output through RunLogger": this banner IS
    // the operator alert channel during headed runs. The full request is
    // already in the structured (redacted) log; the banner carries only the
    // executor-authored reason and the console URL.
    const line = "=".repeat(72);
    console.log(
      [
        "",
        line,
        "  !! HUMAN INTERVENTION REQUIRED — automation is paused !!",
        `     reason:     ${req.reason}`,
        `     capability: ${req.capabilityId}${req.stepId ? ` (step ${req.stepId})` : ""}`,
        `     take over:  ${this.operatorUrl}`,
        line,
        "",
      ].join("\n"),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Operator HTTP surface                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Lazy-start on first raise (no server while automation is healthy), reuse
   * afterwards. A failed start (e.g. port in use) degrades instead of
   * crashing: the intervention still runs and the auto-abort deadline still
   * bounds it — escalation infrastructure must never take down the run.
   */
  private ensureServer(): Promise<http.Server | undefined> {
    if (!this.serverReady) {
      this.serverReady = new Promise((resolve) => {
        const server = http.createServer((req, res) => void this.route(req, res));
        server.on("error", (err) => {
          this.opts.log.event("hitl.server_error", { port: this.port, error: String(err) });
          this.serverReady = undefined; // allow a later raise to retry
          resolve(undefined);
        });
        server.listen(this.port, () => {
          this.opts.log.event("hitl.server_started", { port: this.port, url: this.operatorUrl });
          resolve(server);
        });
      });
    }
    return this.serverReady;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
      if (req.method === "GET" && url.pathname === "/") {
        this.renderPage(res);
        return;
      }
      const shot = /^\/screenshot-(.+)\.png$/.exec(url.pathname);
      if (req.method === "GET" && shot?.[1]) {
        this.serveScreenshot(shot[1], res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/take") {
        await this.handleTake(req, res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/handback") {
        await this.handleHandback(req, res);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } catch (err) {
      this.opts.log.event("hitl.http_error", { error: String(err) });
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("internal error");
    }
  }

  private async handleTake(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const params = new URLSearchParams(await readBody(req));
    const act = this.active;
    // Taking control is only meaningful while control is on offer; stale or
    // double submits (browser refresh, two tabs) fall through harmlessly.
    if (act && this.control.controller === "paused") {
      const operator = (params.get("operator") ?? "").trim() || "operator:unnamed";
      act.operator = operator;
      act.tookControlAt = new Date().toISOString();
      if (act.autoAbortTimer) {
        clearTimeout(act.autoAbortTimer);
        act.autoAbortTimer = undefined;
      }
      this.setController("human", act.id);
      try {
        // The human drives the SAME live session; we only ask the surface to
        // observe them so the intervention record is auditable.
        await this.opts.surface.startHumanRecording();
      } catch (err) {
        this.opts.log.event("hitl.recording_error", { phase: "start", error: String(err) });
      }
      this.opts.log.event("hitl.human_took_control", { interventionId: act.id, operator });
    }
    seeOther(res);
  }

  private async handleHandback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const params = new URLSearchParams(await readBody(req));
    const raw = params.get("disposition");
    const disposition: Disposition | undefined =
      raw === "resumed" || raw === "completed_manually" || raw === "aborted" ? raw : undefined;
    await this.finishIntervention({ disposition });
    seeOther(res);
  }

  private serveScreenshot(id: string, res: http.ServerResponse): void {
    const file = this.screenshots.get(id); // only paths we recorded ourselves
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    fs.createReadStream(file).pipe(res);
  }

  /**
   * One dumb server-rendered page, meta-refreshed every 3s. No SSE, no JS,
   * no assets: the operator console must be the most boring, most reliable
   * component in the system — it is what people reach for when the clever
   * parts have already given up.
   */
  private renderPage(res: http.ServerResponse): void {
    const ctl = this.control;
    const act = this.active;
    const paused = ctl.controller === "paused";

    let body: string;
    if (act) {
      const shot = this.screenshots.has(act.id)
        ? `<h2>Screen at escalation</h2>
           <img class="shot" src="/screenshot-${escapeHtml(act.id)}.png" alt="screenshot at escalation">`
        : "";
      body = `
      <table>
        <tr><th>Reason</th><td>${escapeHtml(act.req.reason)}</td></tr>
        <tr><th>Capability</th><td>${escapeHtml(act.req.capabilityId)}</td></tr>
        <tr><th>Goal</th><td>${escapeHtml(act.req.goal)}</td></tr>
        ${act.req.stepId ? `<tr><th>Step</th><td>${escapeHtml(act.req.stepId)}</td></tr>` : ""}
        <tr><th>Observed state</th><td>${escapeHtml(act.req.observedState)}</td></tr>
        <tr><th>Raised at</th><td>${escapeHtml(act.raisedAt)}</td></tr>
        ${act.operator ? `<tr><th>Operator</th><td>${escapeHtml(act.operator)}</td></tr>` : ""}
      </table>
      ${shot}
      <h2>Actions</h2>
      <form method="post" action="/take" class="row">
        <input name="operator" placeholder="Your name" ${paused ? "" : "disabled"}>
        <button type="submit" ${paused ? "" : "disabled"}>Take control</button>
      </form>
      <p class="hint">Taking control hands you the automation's own live browser window —
        drive it directly, then return control here. Nothing is proxied.</p>
      <form method="post" action="/handback" class="row">
        <button name="disposition" value="resumed">Hand back — resume automation</button>
        <button name="disposition" value="completed_manually">I completed the task manually</button>
        <button name="disposition" value="aborted" class="danger">Abort the run</button>
      </form>`;
    } else {
      body = `<p>No intervention pending. Automation holds control of the session.</p>`;
    }

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<title>Operator Console</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1b1b1b; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1rem; margin-top: 1.5rem; }
  .state { padding: .5rem .8rem; background: #f2f2f2; border-radius: 6px; }
  .state .agent { color: #1a7f37; } .state .paused { color: #b35900; } .state .human { color: #0550ae; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #e2e2e2; vertical-align: top; }
  th { white-space: nowrap; width: 10rem; color: #555; font-weight: 600; }
  .shot { max-width: 100%; border: 1px solid #ccc; border-radius: 4px; margin-top: .5rem; }
  .row { display: flex; gap: .6rem; flex-wrap: wrap; margin: .6rem 0; }
  input { padding: .45rem .6rem; border: 1px solid #bbb; border-radius: 4px; }
  button { padding: .45rem .9rem; border: 1px solid #888; border-radius: 4px; background: #fff; cursor: pointer; }
  button:disabled, input:disabled { opacity: .45; cursor: not-allowed; }
  button.danger { border-color: #c62828; color: #c62828; }
  .hint { color: #666; font-size: .85rem; }
</style>
</head>
<body>
<h1>Operator Console</h1>
<p class="state">Control: <strong class="${ctl.controller}">${ctl.controller}</strong>
 since ${escapeHtml(ctl.since)}${ctl.interventionId ? ` — intervention ${escapeHtml(ctl.interventionId)}` : ""}</p>
${body}
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }
}
