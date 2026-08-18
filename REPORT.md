# Design Report

## 1. Architecture

One process, four seams. The pipeline is:

```
goal ──► discovery loop (LLM) ──► trace ──► compiler ──► capability artifact
                 │                                             │
                 ▼                                             ▼
              Surface  ◄──────────────────────────────  replay executor (no LLM)
            (Playwright)                                       │
                 ▲                                             ▼
          operator broker ◄─── escalation ◄──── policy chokepoint / detectors
```

**Key decisions and trade-offs:**

- **Surface seam.** Everything above `Surface` (loop, compiler, executor,
  broker) speaks in observations, semantic targets, and declarative
  conditions; everything below it is technology-specific perception/action.
  The interface is deliberately accessibility-shaped (roles, names, labels,
  visible text) because those concepts exist on web DOMs, legacy framesets,
  and desktop AX/UIA APIs alike — that one choice is what keeps the artifact
  schema surface-agnostic (§4).
- **Discovery and replay share the surface but not the protocol.** Discovery
  acts on ephemeral element refs from the latest observation (what a model
  can reliably point at); replay acts on recorded locator ladders. Coupling
  them would have forced the model's view into the artifact.
- **Detector knowledge lives per app, not per capability.**
  `config/apps/<appId>.json` holds curated detectors (not-found, validation,
  interstitial, session expiry, app error). The compiler folds them into
  every artifact for that app, so an artifact remains a self-contained,
  reviewable unit while app-level operational knowledge accumulates in one
  place. Trade-off: detectors are curated rather than model-authored — in a
  regulated environment I want error semantics reviewed, not inferred.
- **Single process, no queues.** The interesting problems here are contracts
  and control transfer, not throughput. The executor is a library function; a
  scheduler/queue can wrap it later without changing any contract.
- **Policy is one chokepoint.** `enforce()` gates every action on both paths
  (discovery and replay). A refused action never reaches the surface; on the
  discovery path the refusal text is fed back to the model as a tool result.

## 2. Artifact schema

An artifact is an **agent-invocable contract wrapped around a recorded flow**
(`src/schema/artifact.ts`, zod; round-tripped through the schema before it
can reach disk). Shape highlights and the reasoning:

- **`contract` first**: typed `inputs` (with validation patterns and
  `sensitive` flags), typed `outputs`, and — critically — **enumerated
  `outcomes`** tied to detectors. A calling agent can understand what the
  capability needs, returns, and can legitimately answer ("MEMBER_NOT_FOUND")
  without reading a single step.
- **Locator ladders, not locators.** Every target is a ranked list of
  candidates — `role+name` and `label` first, `text`/`placeholder` next,
  structural CSS always last — each with a recorded `rationale` and
  `confidence`. Replay tries them in order and reports which one won
  (`locatorUsed` per step), which doubles as a drift early-warning signal.
- **Data is never identity.** The compiler refuses to describe or locate an
  extracted element by the value it happened to hold (one member's balance is
  data; encoding it as a locator would silently bind the artifact to that
  member — and leak a sensitive value into the artifact).
- **Templates, never values.** Steps reference `{{inputs.*}}` and
  `{{bindings.*}}`; the compiler parameterizes values (including URL-encoded
  spellings), step intents/ids, and the provenance goal. The invariant: no
  concrete caller value survives into a persisted artifact.
- **`bindings` vs `inputs`**: inputs are caller-supplied per invocation;
  bindings are operator-configured per tenant (the app origin is the first
  one). That split is the multi-tenant seam (§4).
- **Versioned and gated**: `capability.version` increments per re-recording;
  `status: draft | approved` lets unattended replay be gated on review
  (`--require-approved`). `provenance` points at evidence; the model
  transcript never enters the artifact.

## 3. Determinism & error handling

**Determinism.** Replay executes the recorded steps in order with zero model
involvement; the only branching allowed is the declared detector/recovery
table. Waits are explicit conditions (`url_matches` on path+query,
`text_visible`, `element_visible`) with timeouts, not sleeps. Success is
**asserted** by a checkpoint (final URL pattern + extraction target visible),
never assumed.

**The taxonomy separates three things callers must never confuse:**

- **Business outcomes** — enumerated in the contract, detected by declared
  detectors ("no member records matched"). Reported as a *result* with exit
  code 0; conflating these with failures is the classic design mistake.
- **Recoverable conditions** — a known interstitial (declared `dismiss`
  recovery), transient slowness (bounded built-in timeout retry). Handled
  in-run, capped at 2 attempts per step, logged as `recoveries` so
  reliability trends stay visible without polluting the caller contract.
- **Hard failures** — session expiry (deliberately *not* auto-recovered:
  automation must not re-authenticate on its own), app errors, or an
  unexplained state. The run stops with step-level diagnostics: expected vs
  observed, plus captured evidence (screenshot + DOM dump + structured log).

After every step — successful or not — applicable detectors are evaluated
(business outcomes first), so a "successful" click that landed on a
legitimate not-found page is classified correctly rather than failing later
at an unrelated step.

**Drift (secondary).** Ladders absorb small markup changes; `locatorUsed`
falling from semantic candidates to CSS is the drift signal; a re-recording
bumps the version. A build-time lesson that shaped this: Playwright's
`:text()` matches the *smallest* containing element, which in `<font>`-soup
markup is never the `td` — semantic-first ladders exist precisely because
structural assumptions rot.

## 4. Heterogeneity & multi-tenant

**Surfaces.** The artifact schema contains nothing web-specific except the
CSS fallback strategy and URL conditions, both explicitly marked. A desktop
surface (UIA/AX) implements the same `Surface` interface: observations are
role/name element inventories (native accessibility trees), `location()`
returns a window/screen identifier, and url-conditions are replaced by
window-title/element conditions at record time. A screenshot+coordinates
driver fits the same seam for surfaces with no accessibility tree at all —
observation becomes vision-model output; the artifact schema is unchanged.
`framePath` on targets already models legacy frameset nesting.

**Multi-tenant.** Artifacts bind to a **vendor product** (`app.appId`), not a
tenant. Tenant variation enters in exactly two declared places:
`bindings` (origin, and later tenant-specific values) and `tenantOverrides`
(per-tenant binding overrides plus per-step target replacements, applied with
`--tenant`). One artifact serves the hundreds-of-institutions case;
a tenant whose build renames a button gets a target override, not a
re-recording. Drift management: run the capability against a new tenant,
watch `locatorUsed`/failure reports, add overrides where semantic candidates
lose. The detector profile is likewise per-app, shared across tenants.

## 5. Escalation & handoff

**Detecting "stuck".** Three triggers: the discovery model calls `escalate`
(or exhausts max steps); a replay hits a hard failure with
`--escalate-on-failure`; or policy classifies a step risky under the
`escalate` handling mode (§6).

**The control-transfer model** (`src/hitl/`): a single explicit token —
`agent → paused → human → agent` — with timestamped transitions and one
invariant: exactly one controller at any moment, and the browser session
stays alive across the whole cycle. The executor simply awaits the broker;
there is no second session, no state snapshot/restore — the human operates
**the same live session** the automation was using.

Mechanics: `raise()` writes the intervention (reason, capability, step,
observed state, screenshot) and serves a minimal operator console
(localhost:5111). *Take control* flips the token and starts action recording
(clicks/fills/navigations captured with element identity; typed values never
recorded — a fill is logged as `field "Member ID" = [value hidden]`). *Hand
back* offers three dispositions: **resumed** (executor retries the failed
step once, then continues), **completed manually** (executor jumps to
checkpoint verification), **aborted**. Unclaimed interventions auto-abort
after a timeout so automation can never hang forever. The full record —
operator, timestamps, human actions, disposition — is embedded in the
result. The console itself is deliberately bare (meta-refresh HTML); the
*mechanism* — pause, token, live-session transfer, action capture, resume —
is real, which is the part that matters.

## 6. Safety

- **Allowlist**: configurable origins + permitted action types, enforced at
  the single `enforce()` chokepoint before every action on both paths. The
  discovery model receives refusals as feedback; replay reports them as
  failures (or escalates).
- **Risk model**: clicks/presses whose target text matches configurable
  risky patterns (confirm/submit/transfer/open account/...) — or steps the
  artifact explicitly marks `risky` — are handled per policy:
  `block | confirm (explicit --confirm-risky) | escalate` (default: a human
  decides; in a bank back office that is the only defensible default).
  Typing and reading are pre-commit and classified safe.
- **Data handling**: redaction is applied at the *write boundary* (logger and
  artifact writer), not at call sites. Pattern redaction (SSNs, account-like
  numbers, keys) plus run-specific secrets: sensitive **inputs** are scrubbed
  from the start; sensitive **extracted outputs** become secrets the moment
  they are read — masked in all subsequent logs, swept from
  earlier transcript lines at run end, and masked in persisted results, while
  the caller still receives raw values on stdout. Artifacts never contain
  concrete values at all (§2).
- **Known limits**: screenshots and DOM dumps are unredacted by nature —
  they are evidence of screens that contain member data, and in production
  would need masking or a retention/access policy. Pattern-based redaction is
  heuristic; the systematic protections are the ones that don't guess
  (templates-not-values, sensitive flags, write-boundary masking). The
  allowlist is prefix-based and assumes sane origins; it is not a proxy/DNS
  boundary.

## 7. Cuts

Deliberate, with the seam left clean:

- **Operator console is minimal** — bare HTML forms, no auth, no live view.
  The control-transfer model underneath is the real deliverable (§5). Next:
  screencast streaming (CDP), operator identity/authz, notification routing.
- **Desktop surface not implemented** — the seam is designed (§4); building
  a UIA driver was breadth, not depth.
- **Detectors are curated, not learned.** Next: mine discovery/replay
  transcripts to *propose* detectors and outcome codes for human review.
- **Locator ladders come from single-element descriptors.** Next: record
  neighbor/anchor context (row labels, section headings) so extracted data
  cells get semantic *relative* locators instead of structural CSS fallbacks.
- **No queue/scheduler/multi-tenant runtime plumbing** — contracts are shaped
  for it (stateless executor, artifact + inputs in, result out), building it
  now would be premature.
- **Stretch goals**: the capability catalog (`capabilities --json`) is the
  start of the agent-facing interface; approval gating exists
  (`draft/approved` + `--require-approved`). Not built: assisted single-step
  LLM fallback on replay failure (bounded recovery), multi-run stability
  scoring — both fit the existing result/recovery contracts.
