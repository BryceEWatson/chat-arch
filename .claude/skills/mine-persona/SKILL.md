---
name: mine-persona
description: Per-project persona auto-generation. SCAN chain step 5. Reads chat-arch-data/analysis/persona-candidates.json (Stage 1 heuristic buckets produced by the exporter), dispatches per-project synthesis sub-agents that mirror the 4-bucket-by-recency strategy used to author research/persona-evals/bryce.md, and writes analysis/personas.json (index) + analysis/personas/<project-id>.md (per-project markdown). Each persona contains 6-10 numbered pattern sections with **Pattern.** / **Evidence.** (≥2 [SID:...] citations per section) / **What this implies.** Local Ollama NOT required (no embeddings).
---

# /mine-persona

You are running the LLM stage of chat-arch's per-project persona pipeline. The exporter has already produced a heuristic candidate file with 6 buckets per project (`role-expertise` / `preferences` / `project-specific` / `working-rhythm` / `frictions` / `voice`). Your job: synthesize each project's bucketed evidence into a `bryce.md`-shaped persona markdown.

## When to invoke

- The user runs `/mine-persona` (optionally with `--project-id=<id>`).
- The viewer's "FULL SCAN" or "REGEN PERSONA" buttons POST to `/api/mine-persona`. In that case you'll receive a `--request-id` argument and (for the per-project regen path) a `--project-id` argument.

## Arguments

Parse from the user's message. Defaults in brackets.

- `--data-dir <path>` [defaults to `apps/standalone/public/chat-arch-data` relative to repo root]
- `--request-id <uuid>` [omitted] — present when invoked from the viewer; correlates status/output with the UI.
- `--project-id <id>` [omitted] — when present, mine ONLY this project. Everything else stays as-is in `personas.json` (the index is updated in place for that project's row). Used by the PERSONAS surface's REGEN button.
- `--max-projects <N>` [10] — abort if the work plan would process more than N projects in a single run. Same risk shape as `mine-corrections`'s `--max-sub-agents`: each project is ~4 sub-agents (one per time bucket), so 10 projects = up to 40 sub-agent dispatches. Override only when you know the run is bounded (e.g. small corpus).
- `--max-llm-usd-per-project <USD>` [0.5] — pre-flight budget guard. Skip a project (status: `budget-exceeded`) when its predicted Stage-2 cost would exceed this cap. **V1 calibration:** the cost model is a candidate-count proxy enforced via `THRESHOLDS.persona.candidateBudgetProxy` (default 1500 ≈ a 200-session corpus with average bucket density). The actual USD threshold is `THRESHOLDS.persona.maxLlmUsdPerProject` (default $0.50); the proxy is the V1 stand-in until per-Stage-2-run USD measurement lands in V2. Both values live in `packages/analysis/src/thresholds.ts` under the `persona` block.

## Pipeline

You orchestrate four stages. Update the status file at every transition.

### Stage 0 — Setup

1. Resolve `--data-dir`. Read `${dataDir}/analysis/persona-candidates.json`. If absent, tell the user to run `pnpm --filter @chat-arch/exporter run start ...` (or click SCAN in the viewer) first.
2. Read the existing `${dataDir}/analysis/personas.json` if it exists. You'll merge into it rather than overwriting wholesale, so per-project REGENs preserve the rest of the index.
3. Read `${dataDir}/manifest.json` so you can look up session metadata (titles, transcriptPath, updatedAt) by sessionId during the synthesis stage.
4. Read the V1 spec at `research/persona-mining-spec.md` so the persona structure stays anchored to the document Bryce signed off on.
5. Read `research/persona-evals/bryce.md` so you know the structure to mirror: header / 6-10 numbered pattern sections with **Pattern.** / **Evidence.** (≥2 `[SID:...]` citations) / **What this implies.** / coverage notes / optional preserve-automate-get-out-of-the-way table.
6. Build the project work-list:
   - If `--project-id` was passed: list = [that project].
   - Else: list = every project in `persona-candidates.json`.
7. Per project: gate on session count.
   - `sessionsTotal < 30` (or whatever `THRESHOLDS.persona.minSessionsForGeneration` is — read from the `thresholds` field of `persona-candidates.json` rather than re-deriving): emit `status: insufficient-corpus` and skip Stages 1-3 for that project.
   - `cappedCandidatesTotal > THRESHOLDS.persona.candidateBudgetProxy` (default 1500): emit `status: budget-exceeded` with the predicted cost note and skip. Read the value from `persona-candidates.json`'s `thresholds` block (Stage 1 stamps it there so the skill doesn't need to import the analysis package). Until the V1 calibration pass logs actual USD-per-candidate, this proxy is the gate; re-derive the proxy from observed data in V2.
8. If the eligible project count exceeds `--max-projects`:
   - **When `--request-id` is set** (viewer-confirmed run): proceed regardless — the user pressed SCAN knowing it would run. Log a warning to status.
   - **Else**: ask before proceeding.
9. Write the initial status file at `${dataDir}/analysis/persona-status-${requestId}.json` (skip when no requestId).

### Stage 1 — Per-project time-bucket sub-agents

For each eligible project, dispatch **4 parallel sub-agents**, one per time bucket. Bucket assignment uses the project's session updatedAt distribution (read from manifest.json):

- **founding**: oldest 25% of the project's sampled sessions (earliest mtime).
- **mid-early**: next 25%.
- **mid-late**: next 25%.
- **recent**: newest 25%.

Each sub-agent gets:

- The bucket's session ids + their titles + their updatedAt timestamps.
- The candidate excerpts assigned to those sessions, grouped by the 6 heuristic buckets (`role-expertise` etc.). Each candidate is a `{sessionId, userTurnIndex, excerpt, bucket, patternKey}` object.
- The project's display name (for project-specific pattern detection).

Use this exact sub-agent prompt template (substitute the JSON in place of `<<INPUT>>`; the project name in place of `<<PROJECT_NAME>>`; the bucket label in place of `<<TIME_BUCKET>>`):

```
You are extracting persona signals from one time-bucket of a project's chat history.

PROJECT: <<PROJECT_NAME>>
TIME BUCKET: <<TIME_BUCKET>> (one of: founding, mid-early, mid-late, recent)

You have been given user-prompt excerpts pre-classified into 6 heuristic categories:
- role-expertise: claims about the user's profession / experience / stance
- preferences: direct preference statements / "use X not Y" patterns
- project-specific: prompts that name this project or its tech surface
- working-rhythm: process / sequencing / iteration / loop words
- frictions: negative signals about state of work or tool output
- voice: terse pings (≤30 chars) or verbose context blocks (≥1200 chars)

Each excerpt is heuristically matched. Some matches will be noise (an "I prefer" in a code paste, a "frustrating" used in the abstract); your job is to filter those out and surface DURABLE patterns that re-appear across multiple sessions in THIS time bucket.

For each of the 6 categories, return:
{
  "category": "<one of the 6>",
  "observations": [
    {
      "pattern": "<one-sentence summary of what the user is doing/saying/preferring>",
      "evidence": [
        { "sessionId": "<full sid>", "userTurnIndex": <int>, "quote": "<verbatim excerpt, ≤200 chars>" },
        ...
      ]
    }
  ],
  "categoryEmpty": false
}

If a category has no durable pattern in this bucket (e.g. fewer than 2 sessions exhibit the same shape, or all matches are noise), set "observations": [] and "categoryEmpty": true. Do NOT invent patterns to fill the slot.

CONSTRAINTS — non-negotiable:
- Every quote must be VERBATIM from the input. No paraphrasing, no summarization, no quotes from this prompt.
- Every evidence entry must cite at least 2 distinct sessionIds across the bucket's observations PER PATTERN. Patterns with only one supporting session do not count as durable; drop them.
- Group related shapes into ONE pattern. If 8 prompts all say variants of "I prefer terse responses", that's one observation with 4-5 evidence entries, not 8 observations.
- If you cannot find any durable patterns in a category for this bucket, set categoryEmpty: true. Returning a low-signal observation is worse than an empty bucket.

Output ONLY the JSON array (one entry per category, 6 total).

INPUT:
<<INPUT>>
```

Each sub-agent returns its JSON array. Concatenate the four buckets' arrays per project. If any sub-agent fails or returns malformed JSON, retry once; if still bad, drop that bucket with a note in the status log.

### Stage 2 — Cross-bucket synthesis (per project)

For each project, run **one synthesis sub-agent** (no parallelism — coherent prose needs a global view) that takes all four bucket outputs and writes the final persona markdown.

The synthesis sub-agent prompt:

```
You are writing a data-grounded persona for one project, mirroring the structure of `research/persona-evals/bryce.md` (which you should Read before generating this output).

PROJECT: <<PROJECT_NAME>>
SESSIONS ANALYZED: <<SESSIONS_ANALYZED>>
TIME SPAN: <<EARLIEST_DATE>> → <<LATEST_DATE>>

You have been given four time-bucketed observation sets (founding, mid-early, mid-late, recent), each pre-organized into 6 heuristic categories. Your job: produce the persona markdown.

REQUIRED STRUCTURE — match bryce.md verbatim in shape:

1. Header block:
   # Persona — <Project Name>
   One-paragraph intro: project name, sessions analyzed, time span, "data-grounded from N sessions" disclaimer, sentence on the persona's purpose.

2. 6-10 numbered pattern sections, each:
   ## N. <Pattern title>
   **Pattern.** <One-sentence + supporting sentences describing the pattern.>
   **Evidence.**
   - [SID:<prefix>] "<verbatim quote>" — <one-clause hint of why this evidence matters>
   - ... ≥ 2 evidence rows per section ...
   **What this implies for <project>.** <One paragraph on what the persona implies for the project's product / workflow / next steps.>

3. Coverage notes:
   ## Coverage notes
   - Files scanned, time-bucket spread, false-positive filters, confidence
   - What this persona does NOT cover

4. Optional: a "What <project> should preserve, automate, or get out of the way of" table at the bottom — ONLY include this when the patterns are durable across ≥3 of the 4 time buckets. If patterns are only recent, skip the table; that's a persona-drift signal, not a stable preference profile.

CONSTRAINTS — non-negotiable:
- Every `[SID:<prefix>]` citation uses the FIRST 8 CHARS of the sessionId (e.g. `[SID:c9a0169b]`). Match bryce.md's convention.
- Every quote must be VERBATIM from the bucket observations' evidence entries. No paraphrasing.
- Patterns that appear in ≥2 time buckets are DURABLE — prioritize those. Patterns that appear only in `recent` are emerging — flag in the section as "this is recent — durability uncertain".
- 6 to 10 sections total. If you have more than 10 observed shapes, merge the lowest-evidence ones. If fewer than 6, fill from the strongest remaining categoryEmpty=false observations rather than inventing patterns to pad.
- The section order doesn't have to follow the 6 heuristic-category order from Stage 1; group by what makes coherent reading. Voice can be the last section (matches bryce.md).
- Use the same voice as bryce.md — neutral observational, no "the user" filler, no flattery, no hedging.
- Markdown only. No Astro components, no JSX, no HTML tags.

INPUT (four time-bucketed observation arrays):
<<INPUT>>
```

The sub-agent returns markdown directly (no JSON wrapper). Write it to `${dataDir}/analysis/personas/<project-id>.md`. Create the `personas/` directory if it doesn't exist.

### Stage 3 — Index + status

After all per-project syntheses complete (or skip):

1. Read the existing `${dataDir}/analysis/personas.json` (if present) to preserve rows the current run didn't touch.
2. Merge: for each project this run processed, replace its row with the new record:
   ```json
   {
     "projectId": "<id>",
     "projectName": "<display>",
     "sessionsAnalyzed": <int>,
     "sessionsTotal": <int>,
     "personaPath": "analysis/personas/<id>.md" | null,
     "generatedAt": <now ms> | null,
     "status": "generated" | "insufficient-corpus" | "budget-exceeded" | "error",
     "reason": "<free-form, only when status !== 'generated'>"
   }
   ```
3. Write the merged index back to `${dataDir}/analysis/personas.json` with frontmatter:
   ```json
   {
     "schemaVersion": 1,
     "generatedAt": <now ms>,
     "exporterVersion": "<read from analysis/meta.json>",
     "thresholds": {
       "minSessionsForGeneration": <from candidates file>,
       "maxSessionsForCorpus": <from candidates file>,
       "maxLlmUsdPerProject": <THRESHOLDS.persona.maxLlmUsdPerProject>
     },
     "personas": [ <merged records> ]
   }
   ```
4. Update the status file to `complete` with summary counts (generated, skipped, errored).

If a `--request-id` was passed, also write a completion marker at `${dataDir}/analysis/persona-status-${requestId}.json`:

```json
{ "requestId": "<id>", "status": "complete", "completedAt": <now>, "generatedCount": N, "skippedCount": K, "totalProjects": T }
```

## Status file format

`${dataDir}/analysis/persona-status-${requestId}.json`:

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

Update on every stage transition. The viewer polls this for live progress.

## Error handling

- `persona-candidates.json` missing → stop, tell the user to run the exporter first.
- Sub-agent malformed JSON → retry once, then drop that bucket / project and continue.
- `--max-projects` exceeded with no `--request-id` → ask, don't proceed silently. With `--request-id` set, proceed (viewer-confirmed run).
- Any unrecoverable error → write `status: error` with message, exit.

## What you must NOT do

- Don't paraphrase or invent quotes. Every `[SID:...]` evidence line must cite a verbatim user-text excerpt from the input candidates. The Stage-3 follow-up (falsifier extension) will verify this.
- Don't write to `research/persona-evals/<project-id>.md` even if the project name matches. Hand-authored personas under `research/persona-evals/` stay canonical for the projects they cover (`bryce.md` is the chat-arch canonical). Auto-generated personas live ONLY under `analysis/personas/`.
- Don't overwrite the entire `personas.json` index. Merge — preserve rows the current run didn't process.
- Don't dispatch more than `--max-projects` projects worth of sub-agents in one run without explicit user confirmation.
- Don't run the synthesis sub-agent on a project that hit `insufficient-corpus` or `budget-exceeded` — those skip Stages 1-3 entirely; their `personas.json` row is the only artifact.
- Don't add "Generated by Claude" footers or "🤖" emoji to the persona markdown. The headers say "data-grounded from N sessions" which is the only attribution needed.

## Implementation notes

- The 4-bucket-by-recency strategy mirrors how Bryce hand-authored `bryce.md`. Don't change the bucket count without updating the spec.
- The 6 heuristic categories (`role-expertise` / `preferences` / `project-specific` / `working-rhythm` / `frictions` / `voice`) come from the Stage-1 exporter (`packages/exporter/src/analysis/personaCandidates.ts`); the synthesis stage doesn't have to use the same 6 sections in its output — it groups by coherent reading instead.
- `sessionId` truncation to 8 chars in `[SID:...]` is for readability. The full id is preserved in the candidates JSON so the viewer's drill-down hash router (`/sessions#session/<full-sid>`) can resolve it. The viewer's PERSONAS page should hyperlink the 8-char prefix to the full session.
