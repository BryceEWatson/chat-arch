# chat-arch — project notes for Claude

Supplements the global `~/.claude/CLAUDE.md`. Project-specific rules
live here; conflicts resolve in favor of this file.

## Git workflow — ALWAYS use pull requests

**CI is expensive.** The workflow in `.github/workflows/ci.yml` runs
`pnpm install --frozen-lockfile` + `pnpm lint` + `pnpm test` +
`pnpm build` on every trigger, which takes several minutes on a full
monorepo with ~900 packages in the pnpm graph.

Therefore:

1. **Never push directly to `main`.** Push your work to a feature
   branch (`feature/<description>` convention) and open a PR — even
   for small changes.
2. **One CI run per change, not two.** The CI workflow is configured
   to run on both `push: main` and `pull_request:` — if you direct-
   push and also open a PR, you pay for two runs on the same commit.
   Branch-then-PR pays once (the PR run; the post-merge main run is
   the merge commit, a different tree).
3. **Don't force-push to shared branches.** `main` and any branch
   the user has opened a PR on are off-limits to force-push.
4. **Use `gh pr create` after `git push -u origin <branch>`** and
   return the PR URL so the user can jump straight to review.
5. **Squash merge is the project default** (matches the global
   CLAUDE.md convention). The PR-review protocol in the global file
   still applies — verify build/lint/tests pass locally before
   opening.

If you think a change is too small to warrant a PR, ask the user
before direct-pushing. The default answer is "no, still PR it."

## Staging discipline — NEVER `git add -A` / `.` in this repo

`apps/standalone/public/chat-arch-data/manifest.json` is tracked in
its empty baseline form (schemaVersion + zeroed counts + empty
sessions array) but gets *populated on disk* by `pnpm exporter run
start` / the in-app SCAN LOCAL action. The populated content
includes session titles, message previews, per-session USD costs,
and workflow metadata — PII for the developer running the tool.

A staging mistake (`git add -A`, `git add .`, or any pattern that
auto-stages all modified files) can sweep the populated manifest
into a commit. This has already happened once; do not let it happen
again.

Rules:

1. **Stage files by explicit path.** `git add path/to/file.ts`,
   never `-A` / `.` / `--all`. The `.claude/settings.json` here
   denies those patterns at the harness layer; the `.githooks/
   pre-commit` script catches them at the git layer. Both are
   belt-and-suspenders, not replacements for the discipline.
2. **Enable the pre-commit hook on first clone:**
   `git config core.hooksPath .githooks`. (See
   [Quickstart](README.md#quickstart).)
3. **If you see `chat-arch-data/manifest.json` in `git status`
   output as modified, that is local data**. Leave it unstaged.
   Confirm before staging only if the *baseline shape* itself
   changed (e.g., a `schemaVersion` bump that adds a new
   top-level empty field).

Same rule applies to anything else under
`apps/standalone/public/chat-arch-data/` (`corrections.json`,
`applied-improvements.json`, `correction-candidates.json` etc.) —
those are also locally-generated and may carry PII.

## Build / test / lint commands

Run from the repo root:

- `pnpm install --frozen-lockfile` — setup (mirrors CI)
- `pnpm lint` — monorepo-wide
- `pnpm test` — monorepo-wide (vitest)
- `pnpm build` — monorepo-wide (all workspaces build their dist/)

Per-package alternatives:

- `pnpm --filter @chat-arch/viewer <script>` for viewer-only runs
- `pnpm --filter @chat-arch/standalone dev` to boot the dev server
  on port 4321 (via `pnpm dev` at root — Astro's default)

## Shape of the workspace

```
apps/standalone/     Astro shell + /api/rescan + /api/clear endpoints
                     + /api/mine-corrections + /api/clear-corrections
                     + /api/mine-decisions + /api/generate-exports
                     + /api/insights-ack + /api/entity-states
                     + /api/apply-correction + /api/regen-brief
packages/schema/     UnifiedSessionEntry + manifest + correction types
                     + outcome-substrate types (composite-outcome,
                     decision, archetype, narrative, pattern)
packages/exporter/   CLI + parsers + analysis writers + sub-CLIs
                     (embed-cli, ingest-configs-cli,
                      cluster-corrections-cli)
                     + src/export/ Obsidian-targeted export submodule
                     (post-mortems, knowledge-debt)
packages/analysis/   Shared cloud-mapping + clustering +
                     correction-recall kernels + outcome-substrate
                     kernels (composeOutcome, audit*, thresholds,
                     statsShared, itsAnalysis, computeReflexive,
                     surfaceComparisonBuilder, etc.)
packages/viewer/     React viewer (mount target) + 6 outcome-substrate
                     modes (Effectiveness / Insights / Decisions /
                     Trust / Trends / Export) + MethodologyDisclosure
                     + SourceAttribution
packages/mcp-server/ Standalone MCP server exposing @chat-arch/
                     exporter/db SDK as read-only tools to external
                     claude sessions (Rev3-H). Contents:
                     - server.ts (createMcpServer factory),
                     - workingDir.ts (basename+absolute-path guard
                       + traversal check + Win drive-letter case
                       normalization + UNC reject),
                     - readOnly.ts (allow-listed read-verb prefixes
                       + deny-list with embedded-verb segment-scan),
                     - tools.ts (registerSdkTools wires 10 get_/list_
                       MCP tools across projects/topics/narratives/
                       patterns/findings with full SDK-filter parity),
                     - localhostBind.ts (assertLocalhostBind policy
                       gate — IP literals only, no hostname),
                     - tools.gate.test.ts (H5 equivalence gate —
                       tool result deep-equals direct SDK call).
                     The actual MCP protocol layer (stdio transport
                     + @modelcontextprotocol/sdk wiring) lands in a
                     subsequent PR; this scaffold's contract is what
                     the protocol layer plugs into.
scripts/             One-off audits (audit-correction-recall.mjs) +
                     lint scripts (lint-causal-copy.mjs,
                     lint-thresholds-imports.mjs, lint-fixture-pii.mjs)
.claude/skills/
  mine-corrections/  Skill driving the corrections LLM stages
  mine-decisions/    Skill driving the decisions LLM stages (stub UI
                     until LLM pipeline lands; see Phase Rev3-F)
  curate/            Phase Rev3-F F1 curator skill — ranks tier-2 +
                     tier-3 narratives + knowledge-debt + applied-
                     pattern watcher items into analysis/curator-feed.json
                     (read by PRACTICE CuratorFeed component)
  falsify/           Phase Rev3-F F2 falsifier skill — verifies each
                     finding's evidenceChain via per-turn LLM
                     judgments aggregated against
                     THRESHOLDS.curator.falsifierMinSupportRatio;
                     writes analysis/falsifier-verdicts.json
  chat-answer/       Drives /api/chat-answer endpoint (the chat
                     page's agent specialization for Q&A against
                     the corpus)
  mine-persona/      Per-project persona auto-generation V1.
                     Stage 2 of the persona pipeline: reads
                     analysis/persona-candidates.json (Stage 1
                     written by the exporter), dispatches 4 time-
                     bucketed sub-agents per project, synthesizes
                     into analysis/personas/<project-id>.md +
                     updates analysis/personas.json index.
  mine-narratives/   Per-project narrative auto-generation V1.
                     SCAN chain step 6 (after persona). Reads
                     analysis/narrative-candidates.json (Stage 1
                     written by the exporter), dispatches 4 parallel
                     recency-bucket sub-agents per project + 1
                     synthesis sub-agent per project, stamps Stage 2c
                     fields (attributedTo='llm-derived' / confidence /
                     actionType / schemaVersion=2) + validateNarrative
                     drop + sessionId-membership hallucination guard +
                     CAS-on-generatedAt for cross-writer concurrency.
                     Merges via mergeNarrativeFamilies into the shared
                     analysis/narratives.json. Heuristic rows
                     untouched.
  chat-arch-thrash-detect/  NOT in this repo — lives under
                            ~/.claude/skills/ as a global hook
                            (writes thrash-fires.json into the
                            chat-arch corpus when CHATARCH_THRASH_-
                            DETECT=1 is set)
```

Viewer imports from `@chat-arch/analysis`, not `@chat-arch/exporter`
subpaths. The exporter's `exports` field declares two entry points
(`.` for the main runtime and `./export` for the Obsidian-targeted
export submodule); viewer code should stay off both.

## Versioning

User-facing version lives in `packages/exporter/src/analysis/index.ts`
as `EXPORTER_VERSION` and is written into `analysis/meta.json` after
every rescan. Bump it (and add a `CHANGELOG.md` entry) when the on-
disk file shape changes or a user-visible feature ships. Workspace
packages stay at `0.0.0` — they're private and not published.

A second version — `HEURISTIC_RECALL_VERSION` in
`packages/analysis/src/detectCorrectionCandidates.ts` — gates the
incremental-rescan cache for the corrections heuristic. Bump it
whenever you change a regex family in that file; the cache will then
self-invalidate on next rescan. Update the history block in the same
file when you bump.

## Data on disk (for reference when touching wipe/clear logic)

Three IndexedDB databases live on the client:

- `chat-arch` (uploaded ZIP bytes)
- `chat-arch-semantic-labels` (per-session topic assignments)
- `chat-arch-bench-results` (dev-only benchmark metrics)

A "delete cloud data" action must wipe all three — they're all
cloud-corpus-derived. See `NuclearReset.tsx` for the canonical
sequence (Promise.allSettled of the three `clearX()` helpers).

### SQLite substrate (Phase Rev3-A onward)

`apps/standalone/chat-arch-data/chat-arch.db` (plus `.db-wal` and
`.db-shm` siblings during active writes) — the entity-states ledger
(Rev3-C C4) and downstream Rev3 substrate live here. Deliberately a
SIBLING of `public/`, not inside it: Astro serves `public/` at the
URL root, so a DB under `public/chat-arch-data/` would be reachable
at `/chat-arch-data/chat-arch.db` and expose the entire ledger to
anyone who can reach the dev server. The `*.db / *.db-wal / *.db-shm`
gitignore patterns (Rev3-A.A2) cover this family.

**Entity tables in the DB carry PII.** As of Phase Rev3-H this
includes:

- `projects` / `topics` / `sessions` / `session_messages` /
  `session_revisions` — raw transcript content + project / topic
  names extracted from user transcripts.
- `narratives` — schemaVersion 2 (Rev3-B) adds quoted user-text
  excerpts: `intent` + `observation` + `inference` fields are
  narrative prose summarizing what the user did + said. Treat the
  whole narratives table as PII for backup / export decisions.
- `narrative_evidence` — `turnIndex` + verbatim citation snippets
  pointing into session_messages.
- `patterns` — extracted user-facing rules from narratives,
  including the prose body. `falsifier_status` column (Rev3-E)
  is non-PII metadata.
- `findings` — kernel emission payloads (JSON-blob `payload_json`
  column; the SDK row type exposes this as `payloadJson` in
  camelCase) that frequently contain narrative IDs + session anchors
  + summary text.
- `analyzers` — kernel run metadata (calibration state, last-run
  timestamps). Non-PII.
- `narrative_sessions` / `project_sessions` / `project_topics` /
  `topic_sessions` — junction tables linking the above entities.
  No prose, but the linkage itself reveals what a narrative is
  about / what a project covers — PII at the relational level.

The `@chat-arch/mcp-server` package (Rev3-H) exposes a READ-ONLY
SDK surface over this DB to external claude sessions; that's a
deliberate widening of who can see the ledger contents, so the
read-only allowlist + working-dir scoping are load-bearing.
"Read-only" here means SQL-level: no writes, no `exec_`/`run_`
verbs in tool names (`@chat-arch/mcp-server/src/readOnly.ts`),
no `claude -p` exec from the server, no `readFile` outside the
working-dir (`workingDir.ts`). The transport (when it lands in
the protocol PR) is localhost-bind only (`localhostBind.ts`).

Wipe coverage: the `/api/clear` POST handler explicitly extends the
orphan-sweep into the new SQLite substrate (Rev3-A.A9 promise) —
it calls `closeChatArchDb()` to release the OS file handle, then
`wipeSqliteDbFiles()` to unlink the `.db` + `.db-wal` + `.db-shm`
siblings, BEFORE delegating to `clearDataDir.ts`'s `wipeAll` /
`wipeSources` for the JSON-sidecar tree. `wipeAll` itself does NOT
reach the DB (the DB lives under a sibling of `public/`, not under
it) — the endpoint composes the two paths. Next `getChatArchDb`
call re-opens, re-runs migrations on the empty DB, and re-folds any
legacy JSON sidecars (including the legacy `knowledge-debt-state.json`
ledger renamed to `entity-states.json` in Rev3-C C1+C2, then
migrated into the SQLite table in C4) if they survived the sweep.

The corrections pipeline writes three files under
`apps/standalone/public/chat-arch-data/analysis/` (all gitignored):

- `correction-candidates.json` — exporter output (heuristic recall +
  scan stats). Regenerated by `pnpm exporter run start` or
  `/api/rescan`.
- `corrections.json` — skill output (LLM-classified corrections +
  clustered patterns + proposed upgrades). Wiped by
  `/api/clear-corrections`; produced by `/api/mine-corrections`.
- `correction-status-${requestId}.json` — per-run progress files the
  skill writes during a mining pass. The viewer polls them while a
  run is in flight; the clear endpoint sweeps them up.

### Outcome-substrate sidecars (Phase 1-4, introduced in EXPORTER_VERSION 1.2.0)

Eleven additional sidecars under `apps/standalone/public/chat-arch-data/
analysis/` (all gitignored — locally generated, may carry PII):

- `composite-outcomes.json` — per-session composite score + binary
  good/bad classification. PII: session IDs + scores. Foundation; every
  Phase 1-3 surface reads it.
- `pr-land-cache.json` — `gh api` PR merge-state cache (opt-in via
  `--enable-pr-join`). PII: GitHub data (org / repo / PR titles).
- `config-history.json` — `git log` over `~/.claude/`, `~/.claude/
  skills/`, `<project>/.claude/`. PII: commit subjects (reproducible
  from git; not data-on-disk in the same sense as transcripts).
- `its-analysis.json` — interrupted-time-series contrasts of composite
  score around config changes. Aggregate numbers, not PII; gitignored
  conservatively.
- `knowledge-debt.json` + `chat-arch-data/exports/knowledge-debt.md` —
  clustered recurring first-user-turn questions. PII: user questions
  verbatim.
- `reflexive.json` — matched-pair contrast for "touched chat-arch"
  sessions. PII: session IDs + composite scores.
- `decisions.json` — extracted decisions (LF candidates) joined to
  composite outcome. PII: decision prose.
- `archetypes.json` — k-means workflow-archetype centroids + per-
  session assignments. PII: session-archetype mapping.
- `project-trajectories.json` — Theil-Sen slope per project +
  block-bootstrap CI. PII: project name + composite score series.
- `surface-comparison.json` — `(source, archetype)` cell aggregates +
  Holm-Bonferroni pairwise tests. Aggregate numbers; gitignored
  conservatively.
- `skill-curves.json` — per-topic weekly ask-count series + Mann-
  Kendall trend test with BH-FDR. PII: topic + time series.

**Intermediate sidecars (no direct UI surface).** A few artifacts
under `analysis/` exist as inputs to other kernels or downstream
sidecars rather than as something a UI surface reads. If you're
wondering why one of these doesn't show up in the viewer, that's
the reason — not a missing feature, by design. Don't add a surface
for them; the consuming sidecar is what gets rendered.

| Sidecar | Consumer | Direct surface? |
|---|---|---|
| `audit-claims.json` | input to the audit verifier (which writes `audit-results.json`) | no — `/audit` + `/results` read `audit-results.json` |
| `discovery-scores.json` | input to the curator ranker (which writes `curator-feed.json`) | no |
| `duplicates.semantic.json` | input to other clustering kernels | no |
| `pr-land-cache.json` | input to `composite-outcomes.json` (gated by `--enable-pr-join`) | no |

### Feed-redesign Phase A sidecar (EXPORTER_VERSION 1.4.0)

One additional sidecar under `apps/standalone/public/chat-arch-data/
analysis/` (gitignored — locally generated, carries PII):

- `surprises.json` — produced by the `computeSurprises` kernel +
  `surprisesBuilder` shell. Snapshot kernel over the other Phase 1-3
  sidecars; emits a ranked list of nine surprise kinds segmented by
  `tone`: positive (streak / trajectory-accelerating / config-helped
  / pattern-closed / reflexive-positive / decision-paid-off) and
  concerning (trajectory-stalled / pattern-recurring / debt-spinning)
  observations the user might not have noticed. Each row carries
  `{ id, kind, tone, summary (≤120 chars), evidence, score (0-1),
  generatedAt }`. The file also exposes the threshold snapshot it
  used so the UI can disclaim. PII: session IDs + project IDs +
  knowledge-debt canonical-question prose (for `debt-spinning` rows).
  Read by the upcoming feed-redesign UI surface (Phase B, not yet
  landed).

### Rev3-F curator + falsifier output (EXPORTER_VERSION 1.3.0)

Two additional sidecars under `apps/standalone/public/chat-arch-data/
analysis/` (gitignored — locally generated, carry PII):

- `curator-feed.json` — produced by the `/curate` skill. Ranked
  top-K narratives + knowledge-debt clusters + applied-pattern
  watcher items with composite scores + tier-attribution tags +
  falsifier-status. PII: narrative titles + previews, knowledge-
  debt question prose. Read by the PRACTICE surface's CuratorFeed
  component.
- `falsifier-verdicts.json` — produced by the `/falsify` skill.
  Per-finding verdicts (verified / unverified / unavailable) +
  per-turn LLM judgments with citation hygiene checks. PII:
  finding claim text + cited session turn excerpts. Read by the
  curator ranker as a tie-breaker / surfacing gate.

### Wave 2 #1 delta-surprises archive (EXPORTER_VERSION 1.5.0)

One additional sidecar family under
`apps/standalone/public/chat-arch-data/analysis/archive/` (gitignored
under the same wildcard — locally generated, PII-bearing):

- `surprises-YYYY-MM-DD.json` — per-scan snapshot copy of
  `analysis/surprises.json`. Written by `surprisesBuilder` after
  each rescan; pruned to `THRESHOLDS.surprises.archiveRetentionDays`
  (default 30) by filename — NOT mtime, because `git checkout` resets
  timestamps and would otherwise evict the archive. Read by the next
  scan as `priorSurprises` so the kernel can emit delta kinds
  (`streak-extended`, `streak-broken`, `trajectory-flip-up`,
  `trajectory-flip-down`, `pattern-recurrence-resumed`). PII: same
  shape as `surprises.json` itself (summary text + evidence session
  IDs).

### Persona-mining V1 sidecar family (EXPORTER_VERSION 1.6.0)

Three additional artifacts under `apps/standalone/public/chat-arch-data/
analysis/` (all gitignored — locally generated, PII-bearing):

- `persona-candidates.json` — Stage-1 deterministic heuristic
  extractor output. Per-project user-prompt excerpts bucketed into
  6 categories (`role-expertise` / `preferences` / `project-specific` /
  `working-rhythm` / `frictions` / `voice`). Written by
  `packages/exporter/src/analysis/personaCandidates.ts` as part of
  `runAnalysis`. PII: verbatim user-prompt excerpts cited with
  `sessionId` + `userTurnIndex`. Read by the `/mine-persona` skill.
- `personas.json` — Stage-2 index. One record per project in the
  corpus: `{ projectId, projectName, sessionsAnalyzed, sessionsTotal,
  personaPath, generatedAt, status, reason? }`. `status` is
  `generated` / `insufficient-corpus` / `budget-exceeded` / `error`.
  Written by `/mine-persona`. Read by the `/personas` page.
- `personas/<project-id>.md` — per-project markdown persona,
  mirroring `research/persona-evals/bryce.md` structure. Header /
  6-10 numbered pattern sections with **Pattern.** / **Evidence.**
  (≥2 `[SID:...]` citations per section) / **What this implies.** /
  coverage notes. PII: high — every Evidence row is a verbatim
  user-prompt excerpt. Written by `/mine-persona`, rendered by the
  `/personas` page with clickable SID anchors.

**Hand-authored vs auto-generated personas.** The hand-authored
`research/persona-evals/bryce.md` stays canonical for the chat-arch
project specifically (it's the originating prototype). Auto-generated
output lives separately at `analysis/personas/chat-arch.md` — never
overwritten by the skill. The four secondary onramp-eval personas
(`maya.md` / `david.md` / `priya.md` / `sam.md`) are hypothetical
first-touch walkthroughs for the hosted demo, not user-modeling docs,
and are unrelated to the auto-generation pipeline.

**Status files.** `persona-status-${requestId}.json` — per-run
progress file the skill writes during a mining pass. Wiped by
`/api/clear-personas` alongside the personas/ family.

**Wipe coverage.** `/api/clear-personas` (selective) wipes
`personas.json` + status files + `personas/*.md`. `/api/clear`
(kitchen-sink) wipes everything under `chat-arch-data/` via the
existing `wipeAll` path — no new code needed because the personas
family lives under the same root.

### Narrative-mining V1 sidecar family (EXPORTER_VERSION 1.7.0)

One new artifact + two additive optional top-level fields on the
existing `analysis/narratives.json` under
`apps/standalone/public/chat-arch-data/analysis/` (all gitignored —
locally generated, PII-bearing):

- `narrative-candidates.json` — Stage-1 deterministic per-project
  candidate-evidence pool. Per-session candidates (NOT per-user-turn
  like personas — narratives describe session-level themes, not
  user-voice patterns) pre-bucketed by recency quartile (`founding` /
  `mid-early` / `mid-late` / `recent`), each carrying
  `{ sessionId, updatedAt, title, previewExcerpt, summaryExcerpt,
  sentimentPolarity, sentimentStrength, outcomeMarkers }`. Written
  by `packages/exporter/src/analysis/narrativeCandidates.ts` as part
  of `runAnalysis`. PII: verbatim session titles + preview/summary
  excerpts. Read by the `/mine-narratives` skill.
- `narratives.json` (PRE-EXISTING file, V1 adds two additive optional
  top-level fields and a new row family):
  - `thresholds` snapshot — `THRESHOLDS.narrative.*` values the file
    was emitted under. Readers fall back to live `THRESHOLDS` when
    absent.
  - `skipped[]` — per-project skip rows
    (`{ projectId, status, reason }`). `status` is one of
    `insufficient-corpus` / `budget-exceeded` / `no-durable-themes` /
    `synthesis-failed` / `concurrent-rescan-aborted`.
  - New row family: `attributedTo: 'llm-derived'` rows with
    schemaVersion 2, populated provenance triple (intent /
    observation / inference), confidence/supportingCount/contradictingCount.
    Existing heuristic rows continue with `attributedTo:
    'deterministic'` + schemaVersion 1.
  - NO file-level `schemaVersion` bump (existing readers ignore
    unknown top-level keys; the row-level `schemaVersion` 1 | 2
    remains the load-bearing version axis). `EXPORTER_VERSION` 1.6.0
    → 1.7.0 is the auditable cutover.
- `narrative-status-${requestId}.json` — per-run progress file the
  skill writes during a mining pass. Wiped by `/api/clear-narratives`
  alongside any `narratives.json.tmp.*` orphans.

**Two writers, one file.** `narratives.json` has two writers: the
exporter's writer-side migration on every rescan and the
`/mine-narratives` skill on every Stage 2 write. Both route through
`mergeNarrativeFamilies` (preserves heuristic rows + LLM rows of
other projects) + `buildNarrativesFileObject` (file-shape composer)
+ atomic tmp+rename. The skill captures `generatedAt` at Stage 0 and
compare-and-swap-checks before writing; on CAS mismatch it retries
once, then records `concurrent-rescan-aborted` and exits.

**V1 tier-cap on LLM rows.** `narrativeTier()` was extended with an
optional `opts?: { attributedTo?: NarrativeAttribution }` parameter.
When `opts.attributedTo === 'llm-derived'`, the returned tier is
clamped to ≤ 2 — embedded inside `narrativeTier` to preserve the
"single point of truth" invariant. The cap is REMOVED in V1.1 when
the contrary-evidence finder lands; deleting one clause inside
`narrativeTier` is the lift.

**Wipe coverage.** `/api/clear-narratives` (selective) rewrites
`narratives.json` to remove ONLY `attributedTo === 'llm-derived' |
'falsifier-verified'` rows, preserves heuristic rows + `thresholds`
snapshot + unknown top-level keys (round-trip), clears `skipped[]`,
sweeps `narrative-status-*.json` + `narratives.json.tmp.*` orphans.
`/api/clear` (kitchen-sink) wipes everything under `chat-arch-data/`
including `narrative-candidates.json` via the existing `wipeAll`
path. NB the input file `narrative-candidates.json` is NEVER
touched by `/api/clear-narratives` (regenerating it requires
re-running the exporter).

### Project Identity v2 (EXPORTER_VERSION 1.9.0)

`inferProject` (`packages/analysis/src/inferProject.ts`) is a 6-step
**strict first-match** cascade (replacing the old
`project → cwd-basename → title` single-rule classifier). Confidences are
monotonic with order:

```
0. override        1.00  projectOverrides.json (cwdGlob | sessionIds)
1. project_field   1.00  explicit session.project
2. scheduled-task  0.90  routine_<scheduledTaskId> → proj_routine-<slug>
3. vm-folder       0.80  cwdKind==='vm' && basename(userSelectedFolders[0])
4. cwd_basename    0.50  host cwd, OR a vm session with a REAL host-folder cwd
                         (synthetic VM paths are guarded out: /sessions/<haiku>,
                         .claude/worktrees/<haiku>, local_<uuid>/outputs —
                         see isSyntheticVmCwd)
5. title_keyword   0.40  projects.json title-keyword regex
6. unassigned      0.00  __unassigned__
```

`inferProject` has TWO callers — keep both in sync on any return-shape
change: `discoverProjects.ts` and `zombiesHeuristic.ts`.

**New optional `UnifiedSessionEntry` fields** (`packages/schema/src/unified.ts`,
round-trip at schemaVersion 4 — NO `schemaVersion` bump): `scheduledTaskId`
+ `sessionType` (read from the raw Cowork manifest), `parentSessionId`
(spawn-linkage capture; no live signal in the current corpus — lands for the
§14-deferred subagent-attribution feature), `projectAttribution`
(`{ resolvedVia, confidence }`).

**Parse-boundary filter** (`cli.ts` / `cowork.ts`, `isZeroTurnSidecar`): drops
0-turn `ai-title` sidecars when `userTurns===0 && assistantTurns===0 && !cwd
&& !project`. The `&& !cwd && !project` clause is load-bearing — it preserves
the 36 cwd-bearing 0-turn sessions (24 chat-arch). The drop count surfaces as
`parserSkips` in the rescan summary + `analysis/meta.json`.

**Two new gitignored sidecars** under `chat-arch-data/` (PII-bearing;
covered by the `chat-arch-data/*` wildcard, enumerated in `.gitignore`):

- `projectOverrides.json` — manual rule-0 overrides (`{ projectId,
  displayName?, match: { cwdGlob? | sessionIds? } }[]`). `projectId` is a
  RAW key (NOT `proj_`-prefixed — `stableProjectId` re-slugs it). Written by
  the viewer "Move to project" affordance via `/api/move-to-project`
  (local-only, CSRF-gated). Read by `loadProjectOverrides` every rescan; NEVER
  wiped by `/api/clear` (it's user intent, not derived data — sits at the data-
  dir root, not under `analysis/`).
- `analysis/project-identity-preview.json` — the `chat-arch all
  --project-identity-preview` dry-run diff vs the live `projects.json`
  (counts, moved sessions, new/vanished ids, `resolvedViaCounts`,
  `unassignedReasons`). Non-destructive: the preview writes ONLY this file,
  never `manifest.json` / `projects.json`. Adoption = the next normal rescan.

`analysis/projects.json` also gains a top-level `attribution` map
(`{ [sessionId]: { projectId, resolvedVia, confidence } }`) — the
authoritative per-session provenance (the rescan writes the manifest BEFORE
the analysis pass, so projects.json, not the entry, is the source of truth).

**Validation**: `scripts/audit-project-identity.mjs` asserts the post-rescan
targets. **One-time sweep** after the first v2 rescan (skill-written sidecars
keyed to vanished ids): `research/project-identity-v2-sweep.md` — preview →
adopt → `clear-personas` + `clear-narratives` + delete `curator-feed.json` +
`falsifier-verdicts.json` → re-mine → audit.

The pre-launch `thrash-fires.json` audit log (Phase 4 #8 thrash hook)
and the `chat-arch-data/exports/` Obsidian-target directory (Phase 4
#12 post-mortems + knowledge-debt) are also gitignored. The wildcard
`apps/standalone/public/chat-arch-data/*` covers them all; the
explicit entries in `.gitignore` exist as auditable documentation.

**Producer of `thrash-fires.json`:** the
`chat-arch-thrash-detect` skill at
`~/.claude/skills/chat-arch-thrash-detect/` (a global Claude Code
hook), NOT in this repo. The hook is gated on
`CHATARCH_THRASH_DETECT=1`. The chat-arch corpus only consumes the
sidecar; producing it is out-of-tree.

### Fresh-contributor hygiene check (Phase Rev3-I I6)

A fresh contributor cloning this repo should be able to answer the
following from CLAUDE.md alone — if you can't, the section above is
out of date and needs an update:

1. **What's on disk that I should never commit?**
   - SQLite DB family: `apps/standalone/chat-arch-data/chat-arch.db`
     + `.db-wal` + `.db-shm` siblings. Carries the full entity-
     states ledger including narrative prose, pattern bodies,
     finding payloads — full PII.
   - Anything under `apps/standalone/public/chat-arch-data/`
     EXCEPT the tracked empty baseline `manifest.json`. The
     subdirectory contents (analysis sidecars, exports, correction
     status files) are all locally generated; many carry PII.
   - The pre-commit hook at `.githooks/pre-commit` is the
     mechanical guard for both. Enable on first clone with
     `git config core.hooksPath .githooks`.
2. **What PII categories live in the SQLite tables?**
   - `narratives` (schemaVersion 2): quoted user-text excerpts in
     `intent` + `observation` + `inference` columns.
   - `narrative_evidence`: verbatim turn citations.
   - `patterns`: prose body extracted from narratives.
   - `findings`: kernel emission payloads (JSON in `payload_json`
     column / `payloadJson` SDK field) often contain narrative IDs
     + session anchors + summary text.
   - `sessions` + `session_messages` + `session_revisions`: raw
     transcript content.
3. **Where can the SQLite ledger be read from?**
   - Same-process: `@chat-arch/exporter/db` SDK (the standalone
     Astro app + sub-CLIs).
   - External claude sessions: `@chat-arch/mcp-server` exposes a
     READ-ONLY surface via 10 MCP tools (no write verbs, no
     `claude -p` exec, no `readFile` outside `chat-arch-data/`,
     localhost-bind only when the transport PR lands).
4. **What sidecars under `analysis/` carry PII vs aggregate-only?**
   - PII-bearing (most files): composite-outcomes, knowledge-debt,
     reflexive, decisions, archetypes, project-trajectories,
     skill-curves, surprises, archive/surprises-YYYY-MM-DD,
     curator-feed, falsifier-verdicts, correction-candidates,
     corrections, correction-status-*, persona-candidates, personas,
     personas/<project-id>.md, persona-status-*, narrative-candidates,
     narratives (including the V1 LLM-derived row family + the
     `skipped[]` reason text), narrative-status-*.
   - Aggregate-numbers-only (lower-PII): its-analysis, surface-
     comparison. These are gitignored conservatively anyway.
5. **What's the difference between hosted (`chat-arch.dev`) and
   local `pnpm dev`?**
   - Hosted: static Cloudflare Pages build. Demo data + Privacy-
     Export ZIP upload only. No filesystem / process / SQLite /
     MCP. README "Hosted vs local — deliberately scoped divergence"
     has the capability table.
   - Local: full pipeline (SCAN LOCAL, /api/* endpoints, SQLite
     substrate, curator + falsifier skills, MCP server).
6. **When should I bump `EXPORTER_VERSION`?**
   - When the on-disk artifact set EXPANDS (new sidecar) or the
     shape of an existing artifact changes. The version label
     appears in `analysis/meta.json` so operators can correlate a
     bundle with the CHANGELOG. Bumped 1.2.0 → 1.3.0 in Phase
     Rev3-I I5 for the Rev3 substrate cutover; see CHANGELOG.md
     `[1.3.0]` for the full ledger of what landed. Bumped 1.3.0
     → 1.4.0 in the feed-redesign Phase A plumbing when
     `analysis/surprises.json` landed; see CHANGELOG.md `[1.4.0]`.
     Bumped 1.4.0 → 1.4.1 in feed-redesign Phase γ when
     `buildDailyBrief` gained shipped-this-week / surprises /
     trajectories / applied-pattern-closures sections (no new on-
     disk sidecar; brief markdown shape grew); see CHANGELOG.md
     `[1.4.1]`. Bumped 1.5.0 → 1.6.0 in the persona-mining V1 land
     (`persona-candidates.json` + `personas.json` +
     `personas/<project-id>.md` family); see CHANGELOG.md `[1.6.0]`.
     Bumped 1.6.0 → 1.7.0 in the narrative-mining V1 land
     (`narrative-candidates.json` new sidecar + two additive optional
     top-level fields on existing `narratives.json` + new LLM-derived
     row family with `attributedTo: 'llm-derived'`); see CHANGELOG.md
     `[1.7.0]`. Bumped 1.7.0 → 1.9.0 in the Project Identity v2 land
     (skips 1.8.0 — that label is the in-flight UI-content/`unwrapEnvelope`
     branch; reconcile at merge). New optional entry fields
     (`scheduledTaskId` / `sessionType` / `parentSessionId` /
     `projectAttribution`, no `schemaVersion` bump), the `projects.json`
     `attribution` map, `meta.json` `parserSkips`, and two new gitignored
     sidecars (`projectOverrides.json`, `project-identity-preview.json`).
     The bump invalidates the cowork/cli caches so the new entry fields
     repopulate (cascade rule 2 needs `scheduledTaskId`). See CHANGELOG.md
     `[1.9.0]` + the "Project Identity v2" section above.
