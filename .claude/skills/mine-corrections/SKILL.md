---
name: mine-corrections
description: Mine the chat-arch corpus for correction patterns — moments where the user pushed back on the AI — and propose concrete upgrades to CLAUDE.md, skills, agents, commands, or hooks. Detects rules that already exist but are still being violated. Reads chat-arch-data/analysis/correction-candidates.json (produced by the chat-arch exporter) and writes corrections.json with classified patterns and proposed upgrades. Local Ollama required for embeddings.
---

# /mine-corrections

You are running the LLM stages of chat-arch's correction-mining pipeline. The exporter has already produced a heuristic-recall list of candidate corrections. Your job: classify them, cluster repeated rules, check whether each rule already exists in the user's config, and propose concrete upgrades.

## When to invoke

- The user runs `/mine-corrections` (optionally with arguments below).
- The viewer wrote a request to `chat-arch-data/analysis/correction-requests.json` (you'll see a `--request-id` arg in that case).

## Arguments

Parse from the user's message. Defaults in brackets.

- `--data-dir <path>` [defaults to `./chat-arch-data` relative to repo root, or whatever the user names]
- `--window-days <N>` [30] — only process corrections from sessions updated within the last N days. Most-recent-first ordering. **Ignored when `--candidate-ids-file` is also passed.**
- `--candidate-ids-file <path>` [omitted] — JSON file with `{ "ids": ["cor_...", ...] }`. When present, processes ONLY those correction ids regardless of `--window-days`. The API endpoint writes this file when auto-window selects candidates by composite (signal × recency) score rather than a pure time slice. Honor this list verbatim.
- `--request-id <uuid>` [omitted] — present when invoked from the viewer; correlates status/output with the requesting UI.
- `--max-sub-agents <N>` [40] — abort if the work plan would dispatch more than N sub-agents. Each batch of 20 candidates = 1 classification sub-agent; each cluster = 1 proposal sub-agent. The bound prevents a runaway window from quietly burning a chunk of your Claude Code plan usage.
- `--no-llm` [false] — skip stages 2, 4 (proposal LLM); useful for dry runs and CI.
- `--reclassify` [false] — re-process already-classified corrections (default skips them).

## Pipeline

You orchestrate six stages. Update the status file at every transition.

### Stage 0 — Setup

1. Resolve `--data-dir`. Read `${dataDir}/analysis/correction-candidates.json`. If absent, tell the user to run `pnpm --filter @chat-arch/exporter run start ...` first.
2. **If `--candidate-ids-file` is set**: read it, take the `ids` array, filter `correction-candidates.json` to ONLY those ids. Skip the time-window filter entirely. This is the auto-window's preferred path — composite (signal × recency) ranking already happened upstream.
   **Else** (legacy / explicit `--window-days`): filter to candidates from sessions whose `updatedAt` is within `--window-days` of now. Use the manifest at `${dataDir}/manifest.json` to look up session timestamps by `sessionId`. Sort most-recent-first.
4. Verify Ollama is up. Run `Bash`:
   ```
   curl -s -m 1 http://localhost:11434/api/tags > /dev/null && echo OK || echo MISSING
   ```
   If MISSING, tell the user: "Ollama is not running. Install from https://ollama.com, then `ollama pull mxbai-embed-large`." Stop.
5. Estimate sub-agent count: `ceil(numCandidates / 20) + estimatedClusters` (estimate clusters as ~numCandidates/8 for a first pass; tighten on subsequent runs once you know the real cluster ratio). If estimate exceeds `--max-sub-agents`, tell the user the count and ask whether to proceed or narrow the window. All sub-agent calls run inside the parent Claude Code session — no separate billing, but each call counts against the user's plan usage.
6. Write the initial status file.

### Stage 1 — Classification

Goal: turn each candidate into a structured `CorrectionClassification` (kind, distilledRule, confidence, actionable). Drop the rest.

Batch candidates into groups of 20. For each batch, dispatch a `general-purpose` sub-agent **with `model: "haiku"`**. Classification is a structured-output task — Haiku 4.5 handles it well at a fraction of the rate-limit cost of Opus, and proposal generation later (Stage 5) keeps the default Opus where judgment matters. Run multiple batches in parallel — up to 4 at a time — by sending multiple Agent tool calls in a single message.

Use this exact sub-agent prompt template (substitute the candidate JSON in place of `<<CANDIDATES>>`):

```
You are classifying user-corrections-to-AI from a chat transcript. Each input is a {sessionId, userTurnIndex, excerpt, precedingAssistantExcerpt, signals} object.

For each input, decide:
1. Is this an actual correction-to-the-AI (an instruction, behavior rule, format demand) — actionable?
2. If actionable, what KIND: 'behavior-rule' | 'output-format' | 'tool-preference' | 'factual-fix' | 'tone' | 'process' | 'other'.
3. Distill the rule into ONE imperative sentence. No first-person, no project-specific identifiers, no quotes from the assistant. Example: "don't add docstrings unless the user asks." Bad example: "the user wants me to stop adding docstrings."
4. Confidence (0..1): how confident are you this is a real, repeatable correction (not a one-off fix or aside).

Output ONLY a JSON array, one entry per input, same order:
[{"id": "<correction id>", "actionable": true|false, "kind": "...", "distilledRule": "...", "confidence": 0.0-1.0}]

Inputs:
<<CANDIDATES>>
```

Each sub-agent returns its JSON. Concatenate results. If any sub-agent fails or returns malformed JSON, retry once; if still bad, drop those candidates with a status message.

After all batches: filter to `actionable: true` AND `confidence >= 0.6`. Update status: `"classified N of M, K kept after filter"`.

Write the intermediate file `${dataDir}/analysis/_corrections-classified.json` (the leading underscore signals "intermediate, not consumed by viewer"):

```json
{
  "generatedAt": <now>,
  "corrections": [<each Correction with classification populated>],
  "patterns": [],
  "pipeline": { "heuristicRecall": true, "llmClassification": true, "embeddingClustering": false, "claudeMdCrossCheck": false }
}
```

### Stage 2 — Config ingestion

Discover the user's existing CLAUDE.md / skills / agents / commands / settings.

```bash
# Build the project-roots list from the manifest's distinct cwd values.
node -e "
const m = JSON.parse(require('fs').readFileSync('${dataDir}/manifest.json','utf8'));
const roots = [...new Set(m.sessions.map(s => s.cwd).filter(Boolean).filter(c => !c.startsWith('/sessions/')))];
require('fs').writeFileSync('${dataDir}/analysis/_project-roots.json', JSON.stringify(roots));
"

# Run the ingestion CLI. The home-dir default is fine.
node packages/exporter/dist/cli/ingest-configs-cli.js \
  --project-roots-file ${dataDir}/analysis/_project-roots.json \
  --output ${dataDir}/analysis/_configs.json
```

### Stage 3 — Embed everything

Embed (a) the distilled rules, (b) every config sentence. Two batched calls to `chat-arch-embed`.

```bash
# Rules
node -e "
const c = JSON.parse(require('fs').readFileSync('${dataDir}/analysis/_corrections-classified.json','utf8'));
const texts = c.corrections.filter(x => x.classification?.actionable).map(x => x.classification.distilledRule);
require('fs').writeFileSync('${dataDir}/analysis/_rules-input.json', JSON.stringify({ texts }));
"
node packages/exporter/dist/cli/embed-cli.js \
  --input ${dataDir}/analysis/_rules-input.json \
  --output ${dataDir}/analysis/_rules-vectors.json

# Sentences
node -e "
const cf = JSON.parse(require('fs').readFileSync('${dataDir}/analysis/_configs.json','utf8'));
const texts = cf.documents.flatMap(d => d.sentences.map(s => s.text));
require('fs').writeFileSync('${dataDir}/analysis/_sentences-input.json', JSON.stringify({ texts }));
"
node packages/exporter/dist/cli/embed-cli.js \
  --input ${dataDir}/analysis/_sentences-input.json \
  --output ${dataDir}/analysis/_sentences-vectors.json
```

If an embed call fails, surface stderr to the user. Likely cause: Ollama dropped, or the model isn't pulled (`ollama pull mxbai-embed-large`).

### Stage 4 — Cluster + already-encoded check

```bash
node packages/exporter/dist/cli/cluster-corrections-cli.js \
  --classifications ${dataDir}/analysis/_corrections-classified.json \
  --configs ${dataDir}/analysis/_configs.json \
  --output ${dataDir}/analysis/_patterns-no-proposals.json
```

This reads the classifications + configs and writes patterns with `proposedUpgrades: []`. Each pattern has its `alreadyEncoded` and `confidence` fields populated.

Update status: `"clustered into K patterns (J already-encoded)"`.

### Stage 5 — Proposal generation

For each pattern, dispatch a sub-agent to generate `ProposedUpgrade[]`. Process patterns in parallel up to 4 at a time. **Use the default model (Opus)** — proposal generation requires judgment about which target file to recommend, why the existing rule is failing, and what the patch text should say. Don't downgrade to Haiku here.

For each pattern, build the sub-agent prompt with:

- The pattern's `canonicalRule`, `occurrenceCount`, `alreadyEncoded`.
- 3-5 representative instances (excerpt + precedingAssistantExcerpt) — pick the highest-confidence ones.
- The relevant config documents (those whose sentences had highest similarity to the rule). Truncate each to ≤2000 chars.
- The list of distinct project roots affected (lookup via session→cwd from the manifest).

Sub-agent prompt template:

```
You are proposing a concrete fix for a recurring AI-correction pattern.

PATTERN
canonicalRule: <text>
occurrenceCount: <N>
alreadyEncoded: <true|false>
projectsAffected: [<roots>]

INSTANCES (5 most representative):
<excerpt + preceding assistant text for each>

EXISTING USER CONFIG (most relevant, may be empty):
<excerpts of any CLAUDE.md / SKILL.md / agent / command / settings document with high similarity>

PRODUCE: a JSON array of ProposedUpgrade objects, ranked best-first. Each object:
{
  "target": "global-claude-md" | "project-claude-md" | "settings-hook" | "skill" | "prompt-snippet" | "agent" | "command",
  "targetPath": "<concrete file path or settings.json key>",
  "patch": "<the literal text to add or the unified diff if replacing>",
  "rationale": "<one paragraph; cite at least 2 instance ids by '<corId>' format from above>",
  "applied": false,
  "appliedAt": null
}

CONSTRAINTS — non-negotiable:
- patch must be CONCRETE TEXT, not a description of what to add.
- If alreadyEncoded is true: the existing rule is failing. Your top-ranked proposal MUST be a reword (with the failure diagnosed: why is the model violating the existing rule?) OR an escalation to deterministic enforcement (hook). Do NOT propose adding a new rule when one already exists.
- If projectsAffected is one project: prefer project-claude-md over global-claude-md.
- If projectsAffected is many projects: prefer global-claude-md.
- If pattern is process-y and tool-bound (e.g. "always run X before Y"): consider a hook over a CLAUDE.md rule.
- If pattern is workflow-shaped (e.g. "when reviewing code, do X"): consider a skill or agent.
- rationale must cite at least 2 instance ids.
- No flattery. No "you have great instincts." Pure mechanism.
- If you cannot produce ≥1 valid proposal under these constraints, return an empty array. Do not produce a low-quality proposal to fill the slot.

Output ONLY the JSON array.
```

After all sub-agents return, validate each proposal:
- `patch` non-empty
- `targetPath` non-empty
- `rationale` cites at least 2 strings of the form `<corId>` that exist in the cluster's instanceIds
- `target` is one of the allowed values

Drop invalid proposals. If a pattern ends up with zero valid proposals, keep the pattern but with `proposedUpgrades: []` and note it in status.

### Stage 6 — Tag topics

Goal: assign every pattern (this run's new patterns AND any prior patterns preserved across runs) a short topic label that drives dynamic bucketing in the viewer. ONE LLM call sees all patterns at once — clustering needs a global view to keep labels coherent (no fragmentation between "Git Workflow" and "Git Practices").

1. Read existing `${dataDir}/analysis/corrections.json` if present. Collect prior patterns. Combine with this run's freshly-clustered patterns from `_patterns-no-proposals.json` (or with proposals from the staging step above — only `canonicalRule` is needed here).
2. If the combined pattern count is ≤ 1, skip this stage (one pattern doesn't need clustering — leave `topic` undefined).
3. Build the topic-tagging prompt with the full pattern list. Use the **default model (Opus)** — taxonomy quality is the whole point and Haiku tends to over-cluster.

Sub-agent prompt template (single sub-agent, NOT parallelized — taxonomy needs a global view):

```
You are clustering correction patterns into a small number of topic categories. The user will browse patterns grouped by topic, so the labels must be:
- short (1-3 words, Title Case)
- mutually distinct (don't return two labels that mean the same thing)
- balanced (aim for 4-8 topics across the corpus; merge sparingly-populated themes into a broader parent)
- stable in shape across runs (same corpus → same labels)

INPUTS — every pattern in the corpus:
[{"id":"p_...","canonicalRule":"...","occurrenceCount":N,"alreadyEncoded":bool}, ...]

PRODUCE — a JSON object mapping each pattern id to a topic label, plus the deduplicated topic list:
{
  "topics": ["Git Workflow", "Test Discipline", ...],
  "assignments": { "p_abc123": "Git Workflow", "p_def456": "Test Discipline", ... }
}

CONSTRAINTS — non-negotiable:
- Every input id appears in `assignments`. No id is dropped.
- Every value in `assignments` appears in `topics`. No orphan labels.
- Topic labels are 1-3 words, Title Case, no punctuation.
- Don't invent a "Misc" or "Other" bucket. If a pattern truly doesn't fit, group it with the nearest semantic neighbor.
- Don't pad to a fixed count. If the corpus genuinely splits into 3 topics, return 3.

Output ONLY the JSON object.
```

Validate the response:
- Parse as JSON; on failure, retry once. On second failure, log a warning and skip the stage (patterns ship without `topic` — viewer falls back to an Untagged bucket).
- Every pattern id present? Every assigned label in `topics`?
- If validation fails, drop the stage rather than ship inconsistent data.

Apply the assignments: for each pattern in this run's set AND any prior pattern that was passed to the LLM, write `topic = assignments[patternId]`. Patterns NOT in the input list (none, if you built the input correctly) keep their existing `topic` field as-is.

Update status: `"tagged N patterns into K topics: [<topics>]"`.

### Stage 7 — Assemble + write

Merge classifications + patterns + proposals into the final `CorrectionsFile`. **Critical:** preserve any prior corrections in `corrections.json` that this run did NOT touch — they keep their existing classification (or `null` if they were never classified). Only overwrite entries for candidates this run classified.

```json
{
  "generatedAt": <now>,
  "corrections": [<merged: prior entries + this run's freshly classified, classification populated where known, null otherwise>],
  "patterns": [<merged: prior patterns retained, this run's new patterns added>],
  "pipeline": { "heuristicRecall": true, "llmClassification": true, "embeddingClustering": true, "claudeMdCrossCheck": true }
}
```

The merge step is what makes the auto-window's "incremental" promise hold. If you wholesale-replace `corrections.json` with only this run's processed candidates, the next auto-window run will treat anything you didn't touch as unprocessed and try to re-do it.

Write to `${dataDir}/analysis/corrections.json`. Then DELETE the intermediate `_*.json` files (clean up), including the `_correction-target-ids-${requestId}.json` file the API endpoint wrote when `--candidate-ids-file` was used.

Update status to `complete` with summary counts.

If a `--request-id` was passed, also write a completion marker at `${dataDir}/analysis/correction-status-${requestId}.json`:

```json
{ "requestId": "<id>", "status": "complete", "completedAt": <now>, "patternCount": N, "alreadyEncodedCount": K, "tokenCost": "<estimate>" }
```

## Loop closure (subsequent runs)

When invoked with `--reclassify` OR when corrections.json already exists with applied proposals:

1. Load existing corrections.json. Note which patterns have `proposedUpgrades[*].applied === true` with `appliedAt` set.
2. For each "applied" pattern, check whether new corrections (post-`appliedAt`) match the same canonical rule (use embedding similarity ≥ 0.85 against the canonicalRule).
3. If yes: set `recurringPostApplication: true` on that pattern. The viewer surfaces it as "applied but still recurring" — top priority.
4. Also re-read the file at `appliedAt`'s `targetPath`. If the rule's normalized canonical no longer appears there (user edited it away), retire the proposal — set `applied: false` and clear `appliedAt`. The pattern goes back into the queue normally.

## Status file format

`${dataDir}/analysis/correction-status-${requestId}.json`:

```json
{
  "requestId": "<id or 'manual'>",
  "status": "starting" | "classifying" | "ingesting-configs" | "embedding" | "clustering" | "proposing" | "tagging-topics" | "writing" | "complete" | "error",
  "progress": { "phase": "<current>", "current": N, "total": M },
  "startedAt": <ms>,
  "updatedAt": <ms>,
  "log": ["<recent message>", "..."],
  "error": "<message if status=error>"
}
```

Update on every stage transition. The viewer polls this for live progress.

## Error handling

- Ollama down → stop, tell the user how to start.
- Manifest missing → stop, tell the user to run the exporter first.
- Sub-agent malformed JSON → retry once, then drop those candidates and continue.
- Sub-agent count over `--max-sub-agents` → ask, don't proceed silently.
- Any unrecoverable error → write `status: error` with message, exit.

## What you must NOT do

- Don't auto-apply proposals. Writing to `~/.claude/CLAUDE.md` or settings.json without explicit per-proposal user approval is out of scope. Propose only.
- Don't post-process or re-rank proposals from sub-agents. They produce ranked lists; preserve order.
- Don't invent instance ids in citations. The validator drops proposals citing nonexistent ids.
- Don't write to corrections.json until stage 6. Use `_` prefix for all intermediate files.
- Don't re-classify already-classified corrections unless `--reclassify` was passed.
- Don't proceed if cost estimate exceeds the cap; ask first.
