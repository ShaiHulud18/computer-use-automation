# Computer-Use Automation System

An LLM discovers how to operate a legacy bank back-office UI once; the run is
compiled into a typed, versioned **capability artifact**; the artifact then
**replays deterministically** — no model in the loop — with typed inputs,
typed outputs, an explicit error taxonomy, and a human-escalation path that
can take over the live session.

> The model discovers. The artifact becomes a reusable capability.
> Deterministic replay is how the AI agent invokes it in production.

Design write-up: [REPORT.md](REPORT.md). Proof of the end-to-end flow:
[evidence/](evidence/).

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
cp .env.example .env      # then put your Anthropic API key in .env
```

The API key is needed **only for discovery**. Replay is deterministic and
runs without it.

## Demo path

**1. Start the target app** (a deliberately hostile mock "Legacy CU Core"
member-servicing system: server-rendered nested-table HTML 4.01, no ids, no
test attributes, plus a fault-injection API):

```bash
npm run target-app
```

**2. Discovery — the LLM figures out the flow once** (in a second terminal):

```bash
set -a; source .env; set +a
npm run discover -- \
  --goal "Look up member 12345 and read their current savings balance" \
  --capability-id lookup-member-balance \
  --name "Look up member savings balance" \
  --input memberId=12345 \
  --input-spec 'memberId={"type":"string","description":"5-digit member number","required":true,"pattern":"^\\d{5}$","example":"12345"}' \
  --output "memberName=Member's full name as shown on the record" \
  --output "savingsBalance=Current savings balance as displayed on the member record" \
  --sensitive-output savingsBalance
```

This runs a real observe → decide → act loop (screenshots + numbered element
inventory each turn) and compiles `capabilities/lookup-member-balance.v1.json`.
Add `--headless` to hide the browser.

**3. Deterministic replay — different inputs, no LLM:**

```bash
npm run replay -- --artifact capabilities/lookup-member-balance.v1.json --input memberId=23456
```

Returns `success` with `memberName` / `savingsBalance` for a member the model
never saw. Exit codes: `0` success **and** business outcomes, `2` hard
failure, `3` intervention aborted.

**4. Exceptional states:**

```bash
# A legitimate business outcome, not an error:
npm run replay -- --artifact capabilities/lookup-member-balance.v1.json --input memberId=99999
# → status "business_outcome", code MEMBER_NOT_FOUND

# Inject a maintenance interstitial; the declared detector dismisses it and the run recovers:
npx tsx src/cli/index.ts faults --set interstitial --times 1
npm run replay -- --artifact capabilities/lookup-member-balance.v1.json --input memberId=34567

# Caller error, refused before the browser ever launches:
npm run replay -- --artifact capabilities/lookup-member-balance.v1.json --input memberId=12ab
```

**5. Human-in-the-loop escalation** — expire the session mid-run and let a
human rescue the live session:

```bash
npx tsx src/cli/index.ts faults --set session_expired --times 1
npm run replay -- --artifact capabilities/lookup-member-balance.v1.json --input memberId=12345 --escalate-on-failure --headed
```

The run pauses and prints an operator console URL (http://localhost:5111).
Open it, **Take control**, fix the session in the live browser window (click
"Return to sign-in"), then **Hand back — resume automation**. The run resumes
and completes; the intervention record (operator, timestamps, recorded human
actions) is embedded in the result.

**6. The capability catalog** (what an AI agent would discover and invoke):

```bash
npm run capabilities          # human table
npm run capabilities -- --json
```

## Verification

```bash
npm run typecheck
npm test
```

## Layout

| Path | What it is |
| --- | --- |
| `src/schema/` | The contracts: capability artifact + replay result taxonomy |
| `src/surface/` | Surface seam (`types.ts`) + Playwright implementation (`web.ts`) |
| `src/agent/` | Discovery loop, trace recorder, artifact compiler |
| `src/replay/` | Deterministic executor + input/template validation |
| `src/safety/` | Policy allowlist, risk classification (single enforcement chokepoint) |
| `src/hitl/` | Control-transfer model + operator broker |
| `src/target-app/` | The hostile mock bank app with fault injection |
| `config/apps/` | Per-app detector profiles (curated runtime-condition knowledge) |
| `capabilities/` | Compiled capability artifacts |
| `evidence/` | Curated logs/screenshots from the real discovery + replay runs |

All member data in the target app is fictional.
