---
name: mine-decisions
description: Mine the chat-arch corpus for decision points — moments where the user chose between alternatives — and classify each into {kind, distilledDecision, chosen, rejected, rationale, confidence, actionable} plus a trust-calibration cell (did the user take the AI's recommendation, and did it land?). Reads chat-arch-data/analysis/decisions.json (heuristic-recall candidates produced by the exporter), merges classification + trustCalibration back into it, and clusters recurring decisions into analysis/decision-clusters.json. Local Ollama optional (only the clustering stage uses it).
---

# /mine-decisions

You are running the LLM stages of chat-arch's decision-mining pipeline.
The exporter has already produced a heuristic-recall list of candidate
decisions in `decisions.json` (each row a `DecisionCandidate` with
`classification: null`). Your job: classify each into a structured
decision, compute its trust-calibration cell, cluster recurring
decisions, and merge the results back into `decisions.json` without
disturbing rows you didn't touch.

This mirrors `/mine-corrections` (read its SKILL.md for the shared
conventions). The differences: decisions live in a SINGLE file written
by two writers (the exporter + you), so the merge is compare-and-swap
guarded; classification additionally emits an `acceptedAssistant` axis
for trust calibration; and clustering output lives in its own sidecar.

## When to invoke

- The user runs `/mine-decisions` (optionally with the arguments below).
- The viewer's `/api/mine-decisions` endpoint shells out to
  `claude -p "/mine-decisions --request-id=<uuid> --data-dir=<path> --batch=<N>"`.

## Arguments

Parse from the user's message. Defaults in brackets.

- `--data-dir <path>` [`./apps/standalone/public/chat-arch-data`] — the
  chat-arch-data directory.
- `--request-id <uuid>` [omitted] — present when invoked from the viewer;
  correlates the status file with the requesting UI.
- `--batch <N|all>` [5] — classify at most N currently-unclassified
  candidates this run (`all` = no cap). The viewer's batch selector
  drives this. Selection order: candidates WITH a joined `outcomeRef`
  first (more analytically useful — they can form a trust cell), then by
  candidate `id` (stable, deterministic).
- `--self-consistency <K>` [3] — majority-vote count for borderline
  classifications (same mechanism as mine-corrections). `1` disables.
- `--reclassify` [false] — re-process rows that already have a
  `classification` (default skips them).
- `--no-llm` [false] — dry-run: skip classification + clustering, only
  exercise the read/select/status plumbing. Used by CI.
- `--max-sub-agents <N>` [40] — abort if the plan would dispatch more
  than N sub-agents. Each batch of 20 candidates = 1 sub-agent.

## Pipeline

You orchestrate five stages. Update the status file at every transition.

### Stage 0 — Setup

1. Resolve `--data-dir`. Read `${dataDir}/analysis/decisions.json`. If
   absent, tell the user to run the exporter (SCAN LOCAL) first and stop.
2. **Capture `decisions.json`'s `generatedAt` value now** — call it
   `baseGeneratedAt`. Stage 4's compare-and-swap uses it to detect a
   concurrent rescan.
3. Select the work set: rows where `classification === null` (unless
   `--reclassify`, then all rows). Order by `outcomeRef != null` desc,
   then `candidate.id` asc. Cap to `--batch` (no cap when `all`).
4. If the work set is empty, write a `complete` status with
   `classifiedCount: 0` and exit 0 (nothing to do is success).
5. Estimate sub-agents: `ceil(workSet.length / 20)`. If it exceeds
   `--max-sub-agents` AND there is no `--request-id` (direct CLI, a human
   is present), ask before proceeding. When `--request-id` is set
   (viewer run), proceed regardless and log "viewer-run — skipping cap".
6. Write the initial status file (`status: "classifying"`).

If `--no-llm`: skip to Stage 5 and write `complete` with
`classifiedCount: 0`, `dryRun: true`.

### Stage 1 — Classification

Batch the work set into groups of 20. For each batch dispatch a
`general-purpose` sub-agent **with `model: "haiku"`** (structured-output
task — Haiku is cost-correct here). Run up to 4 batches in parallel
(multiple Agent calls in one message).

Build each input row as
`{ id, kind, phrase, context, precedingAssistant }` from the candidate
(`kind` = `candidate.kind`, `phrase` = `candidate.span.phrase`,
`context` = `candidate.surroundingContext`, `precedingAssistant` =
`candidate.precedingAssistantExcerpt`).

Sub-agent prompt template (substitute the batch JSON for `<<CANDIDATES>>`):

```
You are classifying DECISIONS a user made mid-conversation with an AI coding assistant. Each input is a {id, kind, phrase, context, precedingAssistant} object: `context` is the user's turn, `precedingAssistant` is the assistant turn just before it (may be null).

For each input decide:
1. actionable: is this a genuine decision — the user choosing a path, tool, approach, or scope — vs. an aside, a question, a restated earlier decision, or a pleasantry?
2. kind: normalize to one of 'explicit-marker' | 'explicit-go-with' | 'instead-of' | 'alternative-block' | 'imperative-choice' | 'tool-pivot' | 'scope-cut' | 'other'. Reclassify away from the heuristic `kind` when context shows it's really a tool-pivot (switching tool/library/framework) or scope-cut (dropping or deferring planned scope).
3. distilledDecision: ONE imperative sentence naming the decision. No first person, no quotes, no pleasantries. e.g. "use ripgrep instead of grep", "drop the staging server and deploy direct".
4. chosen: array of the option(s) the user took (>=1 entry).
5. rejected: array of option(s) turned down (may be []).
6. rationale: <=200 chars on WHY, in the user's framing. "" if not evident from context.
7. acceptedAssistant: did the user TAKE the assistant's recommendation (true) or go a different way / override it (false)? Judge from precedingAssistant. If there is no preceding assistant turn, or it made no recommendation, use false.
8. confidence: 0..1 that this is a real, substantive decision.

Output ONLY a JSON array, one entry per input, same order:
[{"id":"<id>","actionable":true|false,"kind":"...","distilledDecision":"...","chosen":["..."],"rejected":["..."],"rationale":"...","acceptedAssistant":true|false,"confidence":0.0-1.0}]

Inputs:
<<CANDIDATES>>
```

Concatenate results. On malformed JSON from a sub-agent, retry once,
then drop that batch's candidates with a status note.

**Self-consistency vote** (same shape as mine-corrections): before the
filter, identify the borderline subset (`actionable:true` with
`0.5<=confidence<0.75`, or `actionable:false` with
`0.4<=confidence<0.65`). If `--self-consistency >= 2` and the set is
non-empty, re-run those K-1 more times in parallel and aggregate:
`actionable` = majority (ties → false), `kind` = mode among
actionable-true runs (else 'other'), `distilledDecision`/`rationale`/
`chosen`/`rejected` from the first majority-voting run, `confidence` =
mean, `acceptedAssistant` = majority (ties → false).

**Filter**: keep `actionable: true` AND `confidence >= 0.6`. Map each
kept result to a `DecisionClassification` = `{ kind, distilledDecision,
chosen, rejected, rationale, confidence, actionable: true }`. Update
status: `"classified N of M, K kept after filter"`.

### Stage 2 — Trust calibration

For each kept classification, look up the candidate's `outcomeRef` in
`decisions.json`. When `outcomeRef !== null`, set
`trustCalibration = { acceptedAssistant: <from Stage 1>, landed:
outcomeRef.binaryClass === 'good' }`. When `outcomeRef === null`, leave
`trustCalibration` unset (no outcome to calibrate against). This is what
populates the TRUST 2×2.

### Stage 3 — Cluster recurring decisions (optional; needs Ollama)

Only meaningful with >= 2 classified decisions total (this run's kept
results + any pre-existing classified rows in `decisions.json`).

1. Probe Ollama: `curl -s -m 1 http://localhost:11434/api/tags`. If it's
   not up, **skip this stage** (log "Ollama down — skipping clustering;
   classification still written") and continue. Clustering is an
   enhancement, not a gate — unlike mine-corrections, classification
   here doesn't need embeddings.
2. Collect `{ id, distilledDecision, sessionId, binaryClass }` for every
   classified decision (this run + already-classified rows; `binaryClass`
   from each row's `outcomeRef`, or `null` when unjoined). Write them to
   `_decisions-classified.json` as `{ decisions: [...] }`.
3. Cluster (the CLI embeds `distilledDecision` internally via Ollama, so
   no separate embed-cli call is needed):
   ```bash
   node packages/exporter/dist/cli/cluster-decisions-cli.js \
     --classified ${dataDir}/analysis/_decisions-classified.json \
     --output ${dataDir}/analysis/decision-clusters.json
   ```
   The CLI writes a `DecisionClustersFile` (clusters of >=2 distinct
   sessions, each with `canonicalDecision`, `instanceIds`,
   `occurrenceCount`, `firstSeen`/`lastSeen`, and `landedRate`). Surface
   any stderr.

### Stage 4 — Merge + write (compare-and-swap)

1. **Re-read** `${dataDir}/analysis/decisions.json` fresh.
2. If its `generatedAt !== baseGeneratedAt`, a rescan landed mid-run.
   The candidate `id`s are stable across rescans, so re-applying by id
   is safe — proceed, but if the re-read fails or the file is gone,
   retry once; on a second failure write `status: error` with
   `"concurrent-rescan-aborted"` and exit 1.
3. Build a map `id → { classification, trustCalibration? }` from this
   run. Map over `decisions[]`: for a row whose `candidate.id` is in the
   map, set `classification` (and `trustCalibration` when present),
   preserving `candidate` + `outcomeRef`. Leave every other row
   untouched (their `classification` stays as-is — `null` or a prior
   run's value). Drop map entries whose id is no longer present.
4. Bump `generatedAt` to now; keep `decisionHeuristicVersion` and
   `scannedSessionIds` as read. Write atomically: write to
   `decisions.json.tmp.<requestId>` then rename over `decisions.json`.
5. Delete the `_*.json` intermediates.

### Stage 5 — Status finalization

Write `${dataDir}/analysis/decision-status-${requestId}.json`:

```json
{
  "requestId": "<id or 'manual'>",
  "status": "complete",
  "completedAt": <ms>,
  "classifiedCount": <kept after filter>,
  "candidatesConsidered": <work-set size>,
  "clusterCount": <decision-clusters.json clusters, 0 if skipped>,
  "tokenCost": "<estimate>"
}
```

Also keep the rolling status file (`status` field cycling
`classifying` → `clustering` → `writing` → `complete`) updated through
the run so the viewer's poller shows live progress — same shape as
`correction-status-*.json`.

## Status file format

`${dataDir}/analysis/decision-status-${requestId}.json` — identical
shape to `correction-status-*.json`:

```json
{
  "requestId": "<id or 'manual'>",
  "status": "starting" | "classifying" | "clustering" | "writing" | "complete" | "error",
  "progress": { "phase": "<current>", "current": N, "total": M },
  "startedAt": <ms>,
  "updatedAt": <ms>,
  "log": ["<recent message>", "..."],
  "error": "<message if status=error>"
}
```

## Error handling

- `decisions.json` missing → stop, tell the user to run the exporter.
- Ollama down → skip clustering (NOT fatal); classification still writes.
- Sub-agent malformed JSON → retry once, then drop that batch.
- Concurrent rescan that survives a re-read retry → `status: error`
  (`concurrent-rescan-aborted`), exit 1.
- Any unrecoverable error → write `status: error` with the message, exit 1.

## What you must NOT do

- Don't write to `decisions.json` before Stage 4. Use `_`-prefixed names
  for all intermediates.
- Don't touch rows outside this run's work set — the merge must preserve
  every other row's `classification`/`trustCalibration` verbatim (this
  is what lets the exporter's cache reuse and your classification
  coexist in one file).
- Don't re-classify already-classified rows unless `--reclassify`.
- Don't fail the whole run because Ollama is down — clustering is optional.
- Don't invent `chosen`/`rejected` options not grounded in the context.
