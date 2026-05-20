---
name: mine-decisions
description: STUB (Phase 2 #1 follow-up). Mine the chat-arch corpus for decision points — moments where the user chose between alternatives — and extract {question, alternatives, chosen, rationale} for each. Reads chat-arch-data/analysis/decisions.json (the heuristic-recall candidate file produced by the chat-arch exporter) and overwrites it with classified entries. Local Ollama optional. Currently a stub that emits a "not yet implemented" message and exits.
---

# /mine-decisions

> **STATUS:** Phase 2 #1 follow-up — STUB ONLY. The endpoint and UI
> affordance are live so the user can see where this will plug in,
> but the classification pipeline itself is not yet implemented.
> Running this skill prints a "not yet implemented" message and
> exits non-zero. Track follow-up work under plan §Phase 2 #1.

## When invoked

The viewer's `/api/mine-decisions` endpoint shells out to
`claude -p "/mine-decisions --request-id=<uuid> --data-dir=<path>"`.
Direct CLI invocation works the same way.

## Arguments (planned)

- `--data-dir <path>` — chat-arch-data directory (default:
  `./apps/standalone/public/chat-arch-data`).
- `--request-id <uuid>` — correlates skill output with the requesting
  UI client when invoked from the viewer.
- `--window-days <N>` — process candidates from sessions updated
  within the last N days (default: 30). Same shape as mine-corrections.
- `--no-llm` — dry-run; skip the classification LLM stage.
- `--max-sub-agents <N>` — abort if the plan would dispatch more than
  this many sub-agents. Matches mine-corrections's safety bound.

## Stub behavior (current)

When invoked, this skill MUST:

1. Print a single line to stdout:
   `mine-decisions: not yet implemented (Phase 2 #1 follow-up). See plan §Phase 2 #1.`
2. Exit with status code 1 so the calling endpoint records the run as
   a non-success (the viewer surfaces the message via the NDJSON
   stderr stream).

Do not attempt to read decisions.json, write any sidecar, or
dispatch any sub-agent. The stub exists purely so the UI affordance
(`MINE DECISIONS` button in DecisionsMode) has a real endpoint to
post to.

## Pipeline (planned — for follow-up implementation)

Mirrors mine-corrections's six-stage pipeline:

### Stage 0 — Setup
Read `${dataDir}/analysis/decisions.json`. Filter by window. Verify
Ollama is up (optional for the LF classification pass; required for
clustering by canonical question similarity).

### Stage 1 — Classification
For each `DecisionCandidate` row, extract:
- **Question** — what alternative was being chosen between.
- **Alternatives** — the considered options (chosen + rejected).
- **Chosen** — the selected option(s).
- **Rationale** — short prose explaining why.
- **Confidence** — model self-rated, 0..1.
- **Actionable** — true when the row represents a substantive
  decision (not a pleasantry / wave of the hand).

Batch in groups of 20 → one Haiku sub-agent per batch (matches the
mine-corrections cost profile). Parallelize up to 4 batches at a time.

### Stage 2 — Outcome join
The exporter's `decisionsBuilder.ts` already attaches
`outcomeRef` from composite-outcomes. Re-verify against the current
composite-outcomes.json (older runs may have outdated joins).

### Stage 3 — Trust calibration cell
Compute the 2×2 cell (accepted-assistant × landed) for each
classified decision, populating the optional
`trustCalibration` field on the on-disk Decision row.

### Stage 4 — Cluster by canonical question (optional)
Embed canonicalized question text via Ollama (`mxbai-embed-large`),
cluster by cosine similarity, surface recurring decisions as
"pattern" candidates (same shape as corrections patterns).

### Stage 5 — Status finalization
Write status file
`${dataDir}/analysis/decision-status-${requestId}.json` with
the final state (`status: 'complete' | 'error'`, `error: string?`,
counts).

### Stage 6 — Cleanup
Remove the request-id file (if any), bump
`decisionHeuristicVersion` if the LLM-classification config changed.
