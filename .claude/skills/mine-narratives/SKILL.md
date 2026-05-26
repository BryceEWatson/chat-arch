---
name: mine-narratives
description: Per-project LLM-driven narrative auto-generation. SCAN chain step 6 (after /mine-persona). Reads chat-arch-data/analysis/narrative-candidates.json (Stage 1 deterministic candidate evidence pre-bucketed by recency quartile, produced by the exporter), dispatches 4 parallel per-bucket sub-agents per project + 1 synthesis sub-agent per project, and writes `attributedTo: 'llm-derived'` rows back into the shared analysis/narratives.json via the mergeNarrativeFamilies helper. Heuristic narratives are preserved untouched. Local Ollama NOT required (no embeddings).
---

# /mine-narratives

You are running the LLM stage of chat-arch's per-project narrative pipeline. The exporter has already produced a heuristic candidate file with 4 recency buckets per project (`founding` / `mid-early` / `mid-late` / `recent`). Your job: synthesize each eligible project's bucketed evidence into 3-8 durable narratives and merge them into the shared `analysis/narratives.json` alongside the existing heuristic rows.

## When to invoke

- The user runs `/mine-narratives` (optionally with `--project-id=<id>`).
- The viewer's "FULL SCAN" or per-project "REGEN NARRATIVES" button POSTs to `/api/mine-narratives`. In that case you receive a `--request-id` argument and (for the per-project regen path) a `--project-id` argument.

## Arguments

Parse from the user's message. Defaults in brackets.

- `--data-dir <path>` [defaults to `apps/standalone/public/chat-arch-data` relative to repo root]
- `--request-id <uuid>` [omitted] — present when invoked from the viewer; correlates status/output with the UI.
- `--project-id <id>` [omitted] — when present, mine ONLY this project. All other projects' LLM narratives stay intact (the mergeNarrativeFamilies call uses `mode: { projectId }`). Used by PROJECTS detail's REGEN NARRATIVES button.
- `--max-projects <N>` [10] — abort if the work plan would process more than N projects in a single run. Each project is ~5 sub-agents (4 buckets + 1 synthesis), so 10 projects = up to 50 sub-agent dispatches. Override only when you know the run is bounded.

## Pipeline

You orchestrate three stages. Update the status file at every transition.

### Stage 0 — Setup

1. Resolve `--data-dir`. Read `${dataDir}/analysis/narrative-candidates.json`. If absent, tell the user to run `pnpm --filter @chat-arch/exporter run start ...` (or click SCAN in the viewer) first.
2. Read the V1 spec at `research/narrative-mining-spec.md` so the narrative shape stays anchored to the document Bryce signed off on.
3. Read the existing `${dataDir}/analysis/narratives.json` (as a generic object — there may be unrecognized future top-level keys). Pipe every row through `normalizeNarrativeRow` from `@chat-arch/analysis` (defaults `attributedTo='deterministic'` / `contradictingCount=0` / `verifiedAt=null` for legacy rows) then `classifyAttribution` to split heuristic vs LLM rows. Capture the existing `generatedAt` for the concurrent-rescan CAS check. Capture unrecognized top-level keys as `_passthrough` for round-tripping. Capture the existing `skipped[]` so per-project REGEN preserves the rest.
4. Build the project work-list:
   - If `--project-id` was passed: list = [that project] (and ONLY if the project is present in `narrative-candidates.json` — otherwise error).
   - Else: list = every project in `narrative-candidates.json`.
5. Per project: gate on session count.
   - `sessionsTotal < THRESHOLDS.narrative.minSessionsForLlm` (default 20 — read from the `thresholds` field of `narrative-candidates.json`): emit `{ projectId, status: 'insufficient-corpus', reason: '<N> sessions < <min> minimum' }` into the run's `skipped[]` accumulator. Skip Stages 1-3 for that project. Heuristic rows continue to exist; the skip-row signals "we tried and chose not to enrich."
6. Write the initial status file at `${dataDir}/analysis/narrative-status-${requestId}.json` (skip when no requestId).

### Stage 2a — Per-bucket sub-agents (4 parallel per project)

For each eligible project, dispatch **4 parallel sub-agents**, one per recency bucket. Each sub-agent receives:

- `projectName` — the project's display name.
- `bucketLabel` — one of `founding` / `mid-early` / `mid-late` / `recent`.
- `sessionRows` — the bucket's candidates, each `{ sessionId, updatedAt, title, previewExcerpt, summaryExcerpt, sentimentPolarity, outcomeMarkers }`.

Use this exact sub-agent prompt template (substitute `<<INPUT>>` with the JSON; `<<PROJECT_NAME>>` with the project name; `<<TIME_BUCKET>>` with the bucket label):

```
You are extracting durable thematic-narrative observations from ONE recency bucket of one project's session history.

PROJECT: <<PROJECT_NAME>>
TIME BUCKET: <<TIME_BUCKET>> (one of: founding, mid-early, mid-late, recent)

You have been given per-session candidate rows pre-classified by their sentiment polarity + outcome markers detected in the session title / preview / summary. Some sessions will be noise (a one-off "shipped feature X" with no follow-up); your job is to surface DURABLE patterns — themes that re-appear across multiple sessions in THIS time bucket.

Return:
{
  "bucketLabel": "<founding|mid-early|mid-late|recent>",
  "observations": [
    {
      "narrativeTheme": "<one-sentence theme — e.g. 'ShopForge ships marketplace integrations weekly'>",
      "intent": "<what we were looking for in this bucket>",
      "observation": "<concrete pattern across N sessions — count the sessions>",
      "inference": "<load-bearing claim — what this pattern says about the project>",
      "sentiment": "positive" | "negative",
      "supportingSessionIds": ["<full sid>", ...],
      "evidence": [
        { "sessionId": "<full sid>", "excerpt": "<verbatim title or preview excerpt, ≤200 chars>" },
        ...
      ]
    }
  ],
  "bucketEmpty": false
}

CONSTRAINTS — non-negotiable:

- Every excerpt MUST be VERBATIM from the input session's title / previewExcerpt / summaryExcerpt. No paraphrasing.
- Every observation MUST cite ≥2 distinct supportingSessionIds. Single-session "themes" are anecdotes, not durable narratives — drop them.
- 0-4 observations per bucket. Bucket emits `bucketEmpty: true` when no durable theme survives the ≥2-session rule.

SENTIMENT POLARIZATION RULE — load-bearing:

The downstream validator REJECTS `sentiment: 'neutral'`. Many themes (e.g. "ShopForge ships marketplace integrations weekly") are descriptive and not naturally positive-or-negative. You MUST polarize by outcome-majority of the theme's supportingSessionIds:

1. Count how many supporting sessions have `sentimentPolarity === 'positive'` in the input.
2. Count how many have `sentimentPolarity === 'negative'`.
3. If positives strictly outnumber negatives → emit `sentiment: 'positive'`.
4. If negatives strictly outnumber positives → emit `sentiment: 'negative'`.
5. If TIED → DROP the observation. Do NOT force-emit `sentiment: 'neutral'` (the validator throws) and do NOT pick arbitrarily (poisons signal).

If dropping ambiguous themes leaves the bucket with zero observations, set `bucketEmpty: true`.

Output ONLY the JSON object. INPUT below:

<<INPUT>>
```

Each sub-agent returns its JSON object. Concatenate the four buckets' observations per project. **Recovery semantic (inherited from mine-persona):** if any bucket sub-agent fails or returns malformed JSON, retry once; if still bad, drop THAT bucket with a note in the status log and continue with the remaining buckets.

### Stage 2b — Cross-bucket synthesis (per project, 1 sub-agent)

For each project with at least one non-empty bucket, dispatch **one synthesis sub-agent** that combines the four bucket outputs into 3-8 final narratives. Synthesis sub-agent prompt:

```
You are synthesizing the final narrative set for one project. You have been given 4 recency-bucketed observation arrays (founding / mid-early / mid-late / recent), each pre-organized by the previous stage's sub-agents.

PROJECT: <<PROJECT_NAME>>
PROJECT_ID: <<PROJECT_ID>>

REQUIRED OUTPUT:
{
  "projectId": "<<PROJECT_ID>>",
  "narratives": [
    {
      "id": "narr_llm_<<PROJECT_ID>>_<run-uuid-fragment>",
      "title": "<5-15 word title>",
      "body": "<2-4 paragraph synthesis>",
      "sentiment": "positive" | "negative",
      "sessionIds": ["<all supporting sids merged across buckets>"],
      "evidence": [
        { "sessionId": "<full sid>", "excerpt": "<verbatim quote from a bucket evidence row, ≤200 chars>" },
        ...≥2 evidence rows total...
      ],
      "provenance": {
        "intent": "<what kind of pattern were we looking for>",
        "observation": "<the concrete pattern observed across N sessions>",
        "inference": "<the load-bearing claim — what this means for the project>"
      },
      "supportingCount": <int — count of distinct supporting sessionIds>,
      "contradictingCount": 0,
      "merged": <optional bool — true if this narrative collapsed multiple low-evidence buckets>
    }
  ]
}

CONSTRAINTS — non-negotiable:

- Emit 3-8 narratives. Below 3 you may emit fewer (no padding); above 8 collapse the lowest-evidence themes into a smaller number and flag the collapsed ones with `"merged": true`. Cross-bucket appearance (the same theme in ≥2 buckets) is the strongest "durable" signal — prioritize those.
- IDs MUST start with `narr_llm_<<PROJECT_ID>>_`. Pick a short random UUID fragment for the rest of the id. (V1 IDs are deliberately non-idempotent; deterministic-seed caching is V1.1.)
- Every `evidence[].sessionId` MUST appear in this run's input data — DO NOT cite a session that wasn't surfaced by the bucket sub-agents. The post-LLM hallucination check (Stage 2c) will drop the entire run if it catches a hallucinated sid.
- Every `evidence[].excerpt` MUST be verbatim from the bucket evidence inputs. No paraphrasing.
- `supportingCount` MUST equal the count of distinct sessionIds in `sessionIds[]`.
- `contradictingCount` MUST be 0 (V1 has no contrary-evidence finder; V1.1 introduces it).
- `provenance.intent` / `observation` / `inference` MUST be non-empty strings.
- Same SENTIMENT POLARIZATION RULE as Stage 2a applies — if a synthesized narrative's outcome-majority is tied, DROP the narrative. Do NOT emit `sentiment: 'neutral'`.
- Patterns that appear in ≥2 buckets are DURABLE — prioritize. Recent-only patterns are emerging; flag in the `inference` text as "this is recent — durability uncertain."

Output ONLY the JSON object. INPUTS below (4 bucket arrays):

<<INPUT>>
```

The synthesis sub-agent returns the JSON object. **Recovery semantic:** if it fails or returns malformed JSON, retry once; on second failure, record `{ projectId, status: 'synthesis-failed', reason: 'synthesis sub-agent returned malformed JSON after 1 retry' }` in the run's `skipped[]` accumulator, drop that project's LLM rows for this run, and continue with the remaining projects.

### Stage 2c — Deterministic post-LLM stamping + validation (in-skill, NO LLM)

For each project that returned a synthesis output, do the following IN PROCESS (no further LLM calls):

1. For each row in the synthesis output:
   - Stamp `attributedTo: 'llm-derived'`.
   - Stamp `verifiedAt: null`.
   - Compute `confidence = supportingCount / (supportingCount + contradictingCount + 2)` (the `defaultPrior` from `THRESHOLDS.narrativeRung.defaultPrior` resolves to 2).
   - Stamp `actionType` deterministically from `sentiment` (`positive` → `encode-as-pattern`; `negative` → `generate-corrective-prompt`).
   - Stamp `schemaVersion: 2`.
   - Stamp `generatedAt: new Date(now).toISOString()`.

2. Run `validateNarrative(row)` from `@chat-arch/schema` on each row. Drop on any throw with a log line. Failure causes (defensive — Stage 2b's prompt should prevent most):
   - `sentiment === 'neutral'` (the polarization rule should prevent this; double-check anyway)
   - missing/empty `provenance.{intent,observation,inference}`
   - `actionType` ≠ expected from sentiment
   - `confidence` not in [0,1]
   - `supportingCount` / `contradictingCount` negative
   - `projectId === '[UNASSIGNED]'`

3. **SessionId-membership check (hallucination guard).** For each surviving row, intersect every `sessionId` in `sessionIds[]` AND `evidence[].sessionId` with the Stage-1 candidate set for this project (read from `narrative-candidates.json` at Stage 0). Drop any row where ANY cited sessionId is not in the Stage-1 set, with a log line `"sessionId <sid> not in Stage-1 candidate set for project <projectId>"`.

4. **SupportingCount floor check.** Drop rows whose `supportingCount < THRESHOLDS.narrative.evidenceMinPerNarrative` (default 2).

5. **Post-drop survivor rule.** If `survivors >= THRESHOLDS.narrative.minPerProject` (default 3) → keep them. If `survivors < minPerProject` → DISCARD the project's entire LLM emission for this run, emit `{ projectId, status: 'synthesis-failed', reason: '<N>/<M> narratives failed validateNarrative' }` into `skipped[]`, preserve any prior on-disk LLM rows for that project untouched (via `mergeNarrativeFamilies` `mode: { projectId }` with `incomingLlm: []`).

6. **Concurrent-rescan CAS.** At the START of Stage 2c (before any of the above), capture `existingNarrativesGeneratedAt = <generatedAt read at Stage 0>`. Just before writing in Stage 3, RE-READ `narratives.json` and compare. If `generatedAt` differs:
   - Retry the full Stage 2 ONCE (re-dispatch buckets + synthesis for this project).
   - On second CAS mismatch: emit `{ projectId, status: 'concurrent-rescan-aborted', reason: 'narratives.json was rewritten by a concurrent rescan; the rescan write is canonical' }` and exit cleanly for that project. The rescan's write wins; the LLM rows are wasted for this run.

### Stage 3 — Atomic write to narratives.json

After ALL eligible projects have completed Stage 2c (or recorded skip rows):

1. Read the current on-disk `narratives.json` again (the CAS final read).
2. Pipe every row through `normalizeNarrativeRow` then `classifyAttribution` to split heuristic vs LLM rows. Drop `'unknown'` rows with a log.
3. Call `mergeNarrativeFamilies` from `@chat-arch/analysis`:
   - If `--project-id` was passed: `mode: { projectId: <that id> }`, `incomingLlm: <this run's surviving LLM rows for that project>`.
   - Else: `mode: 'full-rewrite'`, `incomingLlm: <this run's surviving LLM rows across all projects>`.
   - `heuristic: <heuristic rows from on-disk>`, `existingLlm: <LLM rows from on-disk>`.
4. Build the file object via `buildNarrativesFileObject` (from `@chat-arch/exporter`):
   - `generatedAt`: now (ms since epoch).
   - `exporterVersion`: preserve the existing value (or default `'1.7.0'`).
   - `thresholds`: preserve the existing snapshot if present; otherwise emit from `THRESHOLDS.narrative.*`.
   - `narratives`: the merged result.
   - `skipped`: the run's accumulated skip-rows (overwriting the previous file's `skipped[]`).
   - Passthrough: the unrecognized top-level keys captured at Stage 0.
5. Atomic write: use the Bash tool to `Write narratives.json.tmp.<requestId>` followed by `mv narratives.json.tmp.<requestId> narratives.json`. This is the skill-side equivalent of `atomicWriteJson` — the rename is atomic at the FS layer.
6. Write the final status file at `${dataDir}/analysis/narrative-status-${requestId}.json`:
   ```json
   {
     "requestId": "<id>",
     "status": "complete",
     "completedAt": <now>,
     "generatedCount": <N>,
     "skippedCount": <K>,
     "totalProjects": <T>
   }
   ```

## Status file format

`${dataDir}/analysis/narrative-status-${requestId}.json`:

```json
{
  "requestId": "<id or 'manual'>",
  "status": "starting" | "bucketing" | "synthesizing" | "writing" | "complete" | "error",
  "progress": { "phase": "<current>", "current": N, "total": M },
  "startedAt": <ms>,
  "updatedAt": <ms>,
  "log": ["<recent message>", "..."],
  "error": "<message if status=error>"
}
```

Update on every stage transition. The viewer polls this for live progress. The endpoint's `NarrativeOutcomeProbe` requires BOTH `status === 'complete'` AND a fresh `narratives.json.generatedAt >= startedAt` before reporting success.

## Error handling

- `narrative-candidates.json` missing → stop, tell the user to run the exporter first.
- Sub-agent malformed JSON → retry once, then drop that bucket / record `synthesis-failed` for that project, continue.
- CAS mismatch twice → record `concurrent-rescan-aborted` for that project, continue.
- `--max-projects` exceeded with no `--request-id` → ask before proceeding. With `--request-id` set, proceed (viewer-confirmed run).
- Any unrecoverable error → write `status: error` with message, exit.

## What you must NOT do

- Don't paraphrase or invent quotes. Every `evidence[].excerpt` MUST be verbatim from the Stage-1 candidate inputs. Stage 2c's sessionId-membership check is the V1 hallucination guard.
- Don't force-emit `sentiment: 'neutral'`. The schema validator REJECTS it. Polarize by outcome-majority of supporting sessions; drop on tie.
- Don't dispatch sub-agents for projects below `minSessionsForLlm` — they get an `insufficient-corpus` skip-row and the heuristic kernel's existing rows stay untouched.
- Don't write to `narratives.json` non-atomically. Always tmp+rename via Bash. The mv-rename is the FS-layer atomic primitive.
- Don't overwrite the existing `narratives.json` heuristic rows. The `mergeNarrativeFamilies` helper preserves them by construction.
- Don't emit `attributedTo: 'falsifier-verified'` rows. Stage 2c stamps `'llm-derived'`; the V1.1 falsifier hookup is what promotes them.
- Don't add "Generated by Claude" footers / `🤖` emoji to narratives. The provenance triple is the only attribution surface.
- Don't change the V1 tier-cap behavior — `narrativeTier()` clamps LLM rows to tier ≤ 2 in V1; that's the spec.

## Implementation notes

- The 4-recency-bucket strategy mirrors `personaCandidates`'s `sampleSessionsStratifiedByRecency` so founding-era signal is preserved when a project's session count exceeds `maxSessionsForCorpus`. Don't change the bucket count without updating the spec.
- The `[SID:...]` convention in evidence excerpts is for downstream display only; the on-disk `evidence[].sessionId` field is the FULL sid (so the viewer's hash-router can resolve `/sessions#session/<full-sid>`).
- `mergeNarrativeFamilies` log-warns + drops on id collisions between heuristic and LLM families. Your generated ids should never collide (prefix `narr_llm_` vs heuristic's `narr_<projectId>_<polarity>_`); if you see a collision warning, it's a contract violation worth surfacing.
- Cross-project composite narratives are V1.1; this skill only emits per-project rows.
