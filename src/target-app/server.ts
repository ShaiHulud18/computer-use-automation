/**
 * Mock legacy target application — "Legacy CU Core — Member Services".
 * Run with: npx tsx src/target-app/server.ts   (listens on http://localhost:4173)
 *
 * This is the system UNDER automation, deliberately hostile to it:
 *  - server-rendered HTML over bare node:http, classic GET/POST full-page
 *    navigation, no client-side script at all;
 *  - table-based layout with nested tables, presentational markup (<font>,
 *    <center>, bgcolor), meaningless class names ("c1","tb","hd"), and zero
 *    data-test hooks.
 * The one concession to reality: legacy apps DO label their form fields and
 * caption their buttons — so real <label for> associations (with opaque,
 * generated ids/names) and visible button text exist. That is exactly the
 * signal semantic locators (role/name/label/text) key on, and why they beat
 * structural CSS on markup like this.
 *
 * Fault injection (/__faults) lets demos arm deterministic failures for the
 * next N page requests: a maintenance interstitial, a 12s slow response, a
 * session expiry, or a hard 500. See the fault section below for semantics.
 *
 * Logging: this process simulates a third-party vendor system, so it does NOT
 * use the automation stack's RunLogger — it prints one plain line per request
 * to stdout, the way any legacy app server would.
 */
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { SUB_ACCOUNT_TYPES, findMember, formatUsd, type Member } from "./data.js";

const PORT = 4173;
const APP_TITLE = "Legacy CU Core — Member Services";
const SLOW_DELAY_MS = 12_000; // longer than the artifact default step timeout (10s), on purpose

/**
 * Form-field naming: the app's (imaginary) screen generator emits opaque
 * ids/names — that is what makes <label for> the only reliable association.
 * "mid" is pinned by the URL contract (/search?mid=..., /member?mid=...).
 */
const FIELD_MEMBER_ID = "mid";
const FIELD_ACCT_TYPE = "at_cd";
const ID_MEMBER_ID = "fld_x91b";
const ID_ACCT_TYPE = "fld_q44s";

/* ------------------------------------------------------------------ */
/* Mutable server state (in-memory; a restart resets the world)        */
/* ------------------------------------------------------------------ */

type FaultKind = "interstitial" | "slow" | "session_expired" | "error500";
const FAULT_KINDS: readonly FaultKind[] = ["interstitial", "slow", "session_expired", "error500"];

/** Armed fault, applied to the next `times` page requests, then disarmed. */
let armedFault: { fault: FaultKind; times: number } | null = null;

/**
 * Session ids that have expired. Once a sid is here, EVERY page request on it
 * renders the expired page until /signin is visited — that persistence is
 * what makes the escalation demo honest (automation cannot "wait it out").
 */
const expiredSids = new Set<string>();

/** Monotonic counter feeding the "SA-<mid>-<counter>" reference numbers. */
let subAccountCounter = 0;

/** Routes that count as app pages — faults and session checks apply here. */
const PAGE_ROUTES = new Set([
  "/",
  "/search",
  "/member",
  "/member/subaccount",
  "/member/subaccount/review",
  "/member/subaccount/confirm",
]);

/* ------------------------------------------------------------------ */
/* Small HTTP helpers                                                  */
/* ------------------------------------------------------------------ */

function esc(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function getSid(req: http.IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === "sid" && rest.length > 0) return rest.join("=");
  }
  return null;
}

function cookieFor(sid: string): string {
  return `sid=${sid}; Path=/; HttpOnly`;
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
  cookies: string[] = [],
): void {
  const headers: http.OutgoingHttpHeaders = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  };
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(status, headers);
  res.end(html);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------ */
/* HTML — genuinely ugly nested-table chrome, shared by every page     */
/* ------------------------------------------------------------------ */

function page(content: string): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${APP_TITLE}</title>
</head>
<body bgcolor="#e8e4d8" style="margin:0">
<table class="tb" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="hd" bgcolor="#1f3d5c" style="padding:6px 12px">
  <table cellpadding="0" cellspacing="0" border="0"><tr>
    <td><font face="Tahoma" color="#ffffff" size="4"><b>${APP_TITLE}</b></font></td>
  </tr></table>
</td></tr>
<tr><td class="c1" bgcolor="#cdd6df" style="padding:3px 12px">
  <font face="Tahoma" size="2"><a href="/">Home</a></font>
</td></tr>
<tr><td class="c2" style="padding:16px 20px">
${content}
</td></tr>
<tr><td class="ft" bgcolor="#cdd6df" style="padding:3px 12px">
  <font face="Tahoma" size="1" color="#555555">CU Core v2.4.17 &mdash; internal use only. All member data is fictional.</font>
</td></tr>
</table>
</body>
</html>`;
}

function homeContent(): string {
  return `<center>
<font face="Tahoma" size="4"><b>Welcome to Member Services</b></font><br>
<font face="Tahoma" size="2" color="#333333">Core banking back-office terminal. Select a function to begin.</font>
</center>
<br>
<table class="tb" align="center" cellpadding="6" cellspacing="1" border="0" bgcolor="#8a97a5">
<tr bgcolor="#dfe5eb"><td class="hd"><font face="Tahoma" size="2"><b>Functions</b></font></td></tr>
<tr bgcolor="#ffffff"><td class="c1"><font face="Tahoma" size="2"><a href="/search">Member Search</a></font></td></tr>
<tr bgcolor="#ffffff"><td class="c1"><font face="Tahoma" size="2" color="#8a8a8a">Reports (offline)</font></td></tr>
<tr bgcolor="#ffffff"><td class="c1"><font face="Tahoma" size="2" color="#8a8a8a">Batch Posting (offline)</font></td></tr>
</table>`;
}

function searchFormContent(error: string | null): string {
  const banner = error
    ? `<font face="Tahoma" size="2" color="#a40000"><b>${esc(error)}</b></font><br><br>`
    : "";
  return `<font face="Tahoma" size="3"><b>Member Search</b></font><br><br>
${banner}<form method="get" action="/search">
<table class="tb" cellpadding="4" cellspacing="0" border="0">
<tr>
  <td class="c1"><font face="Tahoma" size="2"><label for="${ID_MEMBER_ID}">Member ID</label></font></td>
  <td class="c2"><input type="text" id="${ID_MEMBER_ID}" name="${FIELD_MEMBER_ID}" size="12" maxlength="16"></td>
</tr>
<tr>
  <td class="c1">&nbsp;</td>
  <td class="c2"><button type="submit" class="c1">Search Records</button></td>
</tr>
</table>
</form>
<font face="Tahoma" size="1" color="#666666">Enter the member number exactly as printed on the account card.</font>`;
}

function resultsContent(member: Member): string {
  return `<font face="Tahoma" size="3"><b>Search Results</b></font><br><br>
<table class="tb" width="100%" cellpadding="4" cellspacing="1" border="0" bgcolor="#8a97a5">
<tr bgcolor="#dfe5eb">
  <td class="hd"><font face="Tahoma" size="2"><b>Member ID</b></font></td>
  <td class="hd"><font face="Tahoma" size="2"><b>Name</b></font></td>
  <td class="hd"><font face="Tahoma" size="2"><b>Status</b></font></td>
  <td class="hd">&nbsp;</td>
</tr>
<tr bgcolor="#ffffff">
  <td class="c1"><font face="Tahoma" size="2">${esc(member.id)}</font></td>
  <td class="c1"><font face="Tahoma" size="2">${esc(member.name)}</font></td>
  <td class="c1"><font face="Tahoma" size="2">${statusHtml(member)}</font></td>
  <td class="c1"><font face="Tahoma" size="2"><a href="/member?${FIELD_MEMBER_ID}=${esc(member.id)}">View Record</a></font></td>
</tr>
</table>
<br><font face="Tahoma" size="2"><a href="/search">New Search</a></font>`;
}

function notFoundContent(): string {
  return `<font face="Tahoma" size="3"><b>Search Results</b></font><br><br>
<font face="Tahoma" size="2" color="#7a1f1f">No member records matched your search.</font><br><br>
<font face="Tahoma" size="2"><a href="/search">New Search</a></font>`;
}

function statusHtml(member: Member): string {
  return member.status === "Frozen"
    ? `<font color="#a40000"><b>Frozen</b></font>`
    : esc(member.status);
}

function memberContent(member: Member): string {
  const accountRows = member.accounts
    .map(
      (a) => `<tr bgcolor="#ffffff">
  <td class="c1"><font face="Tahoma" size="2">${a.kind}</font></td>
  <td class="c1" align="right"><font face="Tahoma" size="2">${formatUsd(a.balanceCents)}</font></td>
</tr>`,
    )
    .join("\n");
  return `<h2 class="hd" style="font-family:Tahoma;font-size:15px;margin:0 0 10px 0">Member Record</h2>
<table class="tb" cellpadding="3" cellspacing="0" border="0">
<tr><td class="c1"><font face="Tahoma" size="2"><b>Member ID:</b></font></td>
    <td class="c2"><font face="Tahoma" size="2">${esc(member.id)}</font></td></tr>
<tr><td class="c1"><font face="Tahoma" size="2"><b>Name:</b></font></td>
    <td class="c2"><font face="Tahoma" size="2">${esc(member.name)}</font></td></tr>
<tr><td class="c1"><font face="Tahoma" size="2"><b>Status:</b></font></td>
    <td class="c2"><font face="Tahoma" size="2">${statusHtml(member)}</font></td></tr>
</table>
<br>
<font face="Tahoma" size="2"><b>Accounts</b></font>
<table class="tb" cellpadding="4" cellspacing="1" border="0" bgcolor="#8a97a5">
<tr bgcolor="#dfe5eb">
  <td class="hd" width="180"><font face="Tahoma" size="2"><b>Account</b></font></td>
  <td class="hd" width="120" align="right"><font face="Tahoma" size="2"><b>Balance</b></font></td>
</tr>
${accountRows}
</table>
<br>
<form method="get" action="/member/subaccount">
<input type="hidden" name="${FIELD_MEMBER_ID}" value="${esc(member.id)}">
<button type="submit" class="c1">Open Sub-Account</button>
</form>`;
}

function subaccountFormContent(member: Member): string {
  const options = SUB_ACCOUNT_TYPES.map(
    (t) => `<option value="${esc(t)}">${esc(t)}</option>`,
  ).join("");
  return `<font face="Tahoma" size="3"><b>New Sub-Account Request</b></font><br><br>
<font face="Tahoma" size="2">Member: ${esc(member.id)} &mdash; ${esc(member.name)}</font><br><br>
<form method="post" action="/member/subaccount/review">
<input type="hidden" name="${FIELD_MEMBER_ID}" value="${esc(member.id)}">
<table class="tb" cellpadding="4" cellspacing="0" border="0">
<tr>
  <td class="c1"><font face="Tahoma" size="2"><label for="${ID_ACCT_TYPE}">Account Type</label></font></td>
  <td class="c2"><select id="${ID_ACCT_TYPE}" name="${FIELD_ACCT_TYPE}">${options}</select></td>
</tr>
<tr>
  <td class="c1">&nbsp;</td>
  <td class="c2"><button type="submit" class="c1">Continue</button></td>
</tr>
</table>
</form>`;
}

function reviewContent(member: Member, acctType: string): string {
  return `<font face="Tahoma" size="3"><b>Review Sub-Account Request</b></font><br><br>
<table class="tb" cellpadding="3" cellspacing="0" border="0">
<tr><td class="c1"><font face="Tahoma" size="2"><b>Member:</b></font></td>
    <td class="c2"><font face="Tahoma" size="2">${esc(member.id)} &mdash; ${esc(member.name)}</font></td></tr>
<tr><td class="c1"><font face="Tahoma" size="2"><b>Account Type:</b></font></td>
    <td class="c2"><font face="Tahoma" size="2">${esc(acctType)}</font></td></tr>
</table>
<br>
<font face="Tahoma" size="2" color="#7a1f1f">Please verify the details above. This action posts to the member's record.</font><br><br>
<form method="post" action="/member/subaccount/confirm">
<input type="hidden" name="${FIELD_MEMBER_ID}" value="${esc(member.id)}">
<input type="hidden" name="${FIELD_ACCT_TYPE}" value="${esc(acctType)}">
<button type="submit" class="c1">Confirm Account Opening</button>
</form>`;
}

function confirmContent(member: Member, acctType: string, ref: string): string {
  return `<font face="Tahoma" size="3" color="#0a6b1f"><b>Sub-account opened successfully.</b></font><br><br>
<table class="tb" cellpadding="3" cellspacing="0" border="0">
<tr><td class="c1"><font face="Tahoma" size="2"><b>Reference Number:</b></font></td>
    <td class="c2"><font face="Tahoma" size="2"><b>${esc(ref)}</b></font></td></tr>
<tr><td class="c1"><font face="Tahoma" size="2"><b>Member:</b></font></td>
    <td class="c2"><font face="Tahoma" size="2">${esc(member.id)} &mdash; ${esc(member.name)}</font></td></tr>
<tr><td class="c1"><font face="Tahoma" size="2"><b>Account Type:</b></font></td>
    <td class="c2"><font face="Tahoma" size="2">${esc(acctType)}</font></td></tr>
</table>
<br>
<font face="Tahoma" size="2"><a href="/member?${FIELD_MEMBER_ID}=${esc(member.id)}">Back to record view</a></font>`;
}

/** Full-page maintenance interstitial; Acknowledge posts back the original URL. */
function maintenanceContent(dest: string): string {
  return `<br><br><center>
<table class="tb" width="60%" cellpadding="12" cellspacing="0" border="1" bordercolor="#7a1f1f" bgcolor="#fff6e0">
<tr><td align="center">
<font face="Tahoma" size="4" color="#7a1f1f"><b>Scheduled Maintenance Notice</b></font><br><br>
<font face="Tahoma" size="2">This terminal is inside a scheduled maintenance window and your request was interrupted.
Press the button below to acknowledge this notice and continue to the page you requested.</font><br><br>
<form method="post" action="/__ack">
<input type="hidden" name="dest" value="${esc(dest)}">
<button type="submit" class="c1">Acknowledge</button>
</form>
</td></tr>
</table>
</center>`;
}

function expiredContent(): string {
  return `<br><br><center>
<table class="tb" width="50%" cellpadding="12" cellspacing="0" border="1" bordercolor="#7a1f1f" bgcolor="#fff6e0">
<tr><td align="center">
<font face="Tahoma" size="4" color="#7a1f1f"><b>Session Timeout</b></font><br><br>
<font face="Tahoma" size="2">Your session has expired.</font><br><br>
<font face="Tahoma" size="2"><a href="/signin">Return to sign-in</a></font>
</td></tr>
</table>
</center>`;
}

function errorContent(): string {
  return `<br><br><center>
<font face="Tahoma" size="4" color="#a40000"><b>Application Error (Ref #500)</b></font><br><br>
<font face="Tahoma" size="2">An unexpected condition prevented the system from fulfilling the request.
Contact the core operations desk and quote the reference above.</font>
</center>`;
}

/** Shown when review/confirm are reached without their form POST. */
function stalePostContent(): string {
  return `<font face="Tahoma" size="3"><b>Request Incomplete</b></font><br><br>
<font face="Tahoma" size="2">This page must be reached by submitting the preceding form.</font><br><br>
<font face="Tahoma" size="2"><a href="/search">Member Search</a></font>`;
}

/* ------------------------------------------------------------------ */
/* Fault-injection control API                                         */
/* ------------------------------------------------------------------ */

function faultState(): Record<string, unknown> {
  return {
    fault: armedFault?.fault ?? null,
    times: armedFault?.times ?? 0,
    expiredSessions: expiredSids.size,
  };
}

async function handleFaultApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === "GET") {
    sendJson(res, 200, faultState());
    return;
  }
  if (req.method === "DELETE") {
    // Harness-level "reset the world" control. It also clears expired
    // sessions for convenience between scenarios — the honest IN-SESSION
    // recovery path for automation remains /signin, which policy forbids
    // the agent from taking on its own.
    armedFault = null;
    expiredSids.clear();
    sendJson(res, 200, faultState());
    return;
  }
  if (req.method === "POST") {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req)) || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const record = parsed as { fault?: unknown; times?: unknown };
    const fault = record.fault;
    const times = record.times ?? 1;
    if (typeof fault !== "string" || !(FAULT_KINDS as readonly string[]).includes(fault)) {
      sendJson(res, 400, { error: `"fault" must be one of: ${FAULT_KINDS.join(", ")}` });
      return;
    }
    if (typeof times !== "number" || !Number.isInteger(times) || times < 1 || times > 20) {
      sendJson(res, 400, { error: '"times" must be an integer between 1 and 20' });
      return;
    }
    armedFault = { fault: fault as FaultKind, times };
    sendJson(res, 200, faultState());
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}

/** Acknowledge on the interstitial: redirect back to the hijacked URL. */
async function handleAck(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const dest = new URLSearchParams(await readBody(req)).get("dest") ?? "/";
  // Local-path check: the dest round-trips through the browser, so never
  // allow it to become an absolute/protocol-relative redirect.
  const safe = dest.startsWith("/") && !dest.startsWith("//") ? dest : "/";
  res.writeHead(303, { location: safe });
  res.end();
}

/**
 * Sign-in stub: un-expires the caller's session and issues a fresh sid.
 * Exempt from fault injection — recovery endpoints must not themselves be
 * faultable or the escalation demo deadlocks. Automation policy forbids the
 * agent from visiting this; it exists for the human operator during handoff.
 */
function handleSignin(req: http.IncomingMessage, res: http.ServerResponse): void {
  const sid = getSid(req);
  if (sid) expiredSids.delete(sid);
  res.writeHead(302, { location: "/", "set-cookie": cookieFor(randomUUID()) });
  res.end();
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // Control-plane endpoints: never faulted, never session-checked.
  if (path === "/__faults") return handleFaultApi(req, res);
  if (path === "/__ack") {
    if (req.method === "POST") return handleAck(req, res);
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  if (path === "/signin") return handleSignin(req, res);
  if (path === "/favicon.ico") {
    res.writeHead(404);
    res.end();
    return;
  }

  if (!PAGE_ROUTES.has(path)) {
    sendHtml(res, 404, page(`<font face="Tahoma" size="2">Unknown screen: ${esc(path)}</font>`));
    return;
  }

  // --- session: every page request carries a sid cookie ---
  let sid = getSid(req);
  const cookies: string[] = [];
  if (!sid) {
    sid = randomUUID();
    cookies.push(cookieFor(sid));
  }
  if (expiredSids.has(sid)) {
    // Expiry is sticky per-session: every page renders this until /signin.
    sendHtml(res, 200, page(expiredContent()), cookies);
    return;
  }

  // --- fault injection: applies to the next N page requests ---
  const pending = armedFault;
  // The interstitial's Acknowledge replays the original request as a GET, so
  // hijacking a POST would corrupt a form flow — interstitials wait for the
  // next GET instead. All other faults hit any method.
  if (pending && (pending.fault !== "interstitial" || req.method === "GET")) {
    pending.times -= 1;
    if (pending.times <= 0) armedFault = null;
    switch (pending.fault) {
      case "interstitial":
        sendHtml(res, 200, page(maintenanceContent(url.pathname + url.search)), cookies);
        return;
      case "session_expired":
        expiredSids.add(sid);
        sendHtml(res, 200, page(expiredContent()), cookies);
        return;
      case "error500":
        sendHtml(res, 500, page(errorContent()), cookies);
        return;
      case "slow":
        await sleep(SLOW_DELAY_MS); // then fall through and serve normally
        break;
    }
  }

  // --- normal pages ---
  switch (path) {
    case "/":
      sendHtml(res, 200, page(homeContent()), cookies);
      return;

    case "/search": {
      const raw = url.searchParams.get(FIELD_MEMBER_ID);
      if (raw === null) {
        sendHtml(res, 200, page(searchFormContent(null)), cookies);
        return;
      }
      const mid = raw.trim();
      if (!/^\d{5}$/.test(mid)) {
        sendHtml(res, 200, page(searchFormContent("Member ID must be a 5-digit number.")), cookies);
        return;
      }
      const member = findMember(mid);
      sendHtml(res, 200, page(member ? resultsContent(member) : notFoundContent()), cookies);
      return;
    }

    case "/member": {
      const member = findMember((url.searchParams.get(FIELD_MEMBER_ID) ?? "").trim());
      sendHtml(res, 200, page(member ? memberContent(member) : notFoundContent()), cookies);
      return;
    }

    case "/member/subaccount": {
      const member = findMember((url.searchParams.get(FIELD_MEMBER_ID) ?? "").trim());
      sendHtml(res, 200, page(member ? subaccountFormContent(member) : notFoundContent()), cookies);
      return;
    }

    case "/member/subaccount/review": {
      if (req.method !== "POST") {
        sendHtml(res, 405, page(stalePostContent()), cookies);
        return;
      }
      const form = new URLSearchParams(await readBody(req));
      const member = findMember((form.get(FIELD_MEMBER_ID) ?? "").trim());
      if (!member) {
        sendHtml(res, 200, page(notFoundContent()), cookies);
        return;
      }
      const acctType = form.get(FIELD_ACCT_TYPE) ?? "";
      if (!SUB_ACCOUNT_TYPES.includes(acctType)) {
        // Unknown product code: bounce back to the request form.
        sendHtml(res, 200, page(subaccountFormContent(member)), cookies);
        return;
      }
      sendHtml(res, 200, page(reviewContent(member, acctType)), cookies);
      return;
    }

    case "/member/subaccount/confirm": {
      if (req.method !== "POST") {
        sendHtml(res, 405, page(stalePostContent()), cookies);
        return;
      }
      const form = new URLSearchParams(await readBody(req));
      const member = findMember((form.get(FIELD_MEMBER_ID) ?? "").trim());
      const acctType = form.get(FIELD_ACCT_TYPE) ?? "";
      if (!member || !SUB_ACCOUNT_TYPES.includes(acctType)) {
        sendHtml(res, 200, page(stalePostContent()), cookies);
        return;
      }
      subAccountCounter += 1;
      const ref = `SA-${member.id}-${subAccountCounter}`;
      sendHtml(res, 200, page(confirmContent(member, acctType, ref)), cookies);
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(
      `${new Date().toISOString()} ${req.method ?? "?"} ${req.url ?? "?"} -> ${res.statusCode} ${Date.now() - startedAt}ms`,
    );
  });
  route(req, res).catch((err: unknown) => {
    // Last-resort guard: a handler bug must not kill the mock mid-demo.
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
    console.log(`handler error: ${err instanceof Error ? err.message : String(err)}`);
  });
});

server.listen(PORT, () => {
  console.log(`${APP_TITLE} — mock target app listening on http://localhost:${PORT}`);
});
