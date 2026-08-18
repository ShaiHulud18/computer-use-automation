# Evidence

Curated proof of the end-to-end flow (see /REPORT.md). Every directory is a
verbatim copy of a real run directory produced by the system; nothing here is
hand-edited. Sensitive outputs (`savingsBalance` is declared sensitive) appear
masked in logs and persisted results by design — the caller received the raw
value on stdout.

- `discovery-run/` — the genuine LLM-driven discovery run (Claude Sonnet
  driving the live legacy UI over 8 turns): `transcript.jsonl` (redacted model
  transcript; screenshots referenced, base64 elided), `log.jsonl` (structured
  events), `obs-*.png` (what the model saw each turn), and `artifact.json`
  (the compiled capability — a copy of
  `capabilities/lookup-member-balance.v1.json`).
- `replay-run/` — deterministic replay of that artifact with a DIFFERENT
  member id (23456) and no LLM in the loop: `log.jsonl` + `result.json`
  (status `success`, outputs returned, per-step locator report).
- `replay-outcome-not-found/` — replay with an unknown member id (99999):
  status `business_outcome` / `MEMBER_NOT_FOUND` — a legitimate answer for
  the caller, cleanly distinguished from failure.
- `replay-error-run/` — replay with an injected maintenance-interstitial
  fault: the `maintenance-interstitial` detector fires, the declared
  `dismiss` recovery runs, the step reports `recovered`, and the run still
  succeeds.
- `replay-escalation-run/` — replay with an injected session-expiry fault and
  `--escalate-on-failure`: the run pauses, an intervention with full context
  (`intervention-*.json`, screenshot, failure evidence) is routed to the
  operator console, a human takes control of the live session, restores it,
  hands back, and the run resumes to `success` — the intervention record
  (operator, timestamps, disposition) is embedded in `result.json`.

Raw working runs land in `runs/` (gitignored); these are the curated copies
referenced by the report.
