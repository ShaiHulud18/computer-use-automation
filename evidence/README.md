# Evidence

Curated proof of the end-to-end flow (see /REPORT.md):

- `discovery-run/` — a genuine LLM-driven discovery run: redacted model
  transcript, structured event log, per-step screenshots, and the artifact
  it produced.
- `replay-run/` — a deterministic replay of that artifact with different
  input parameters (no LLM in the loop): structured log + result JSON.
- `replay-outcome-not-found/` — a replay that hits a legitimate business
  outcome (unknown member id) and reports it as a result, not an error.
- `replay-error-run/` — a replay against an injected runtime fault, showing
  detection, recovery/failure classification, and captured evidence.

Raw working runs land in `runs/` (gitignored); these directories are the
curated copies referenced by the report.
