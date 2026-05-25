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
     skill-curves, surprises, curator-feed, falsifier-verdicts,
     correction-candidates, corrections, correction-status-*.
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
