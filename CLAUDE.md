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
                     claude sessions (Rev3-H). H1+H2 scaffold ships
                     the workingDir scoping + read-only verb
                     allowlist + server factory. H3 plugs the actual
                     MCP protocol layer + SDK query tools on top;
                     H4 enforces localhost-bind; H5 gate test.
scripts/             One-off audits (audit-correction-recall.mjs) +
                     lint scripts (lint-causal-copy.mjs,
                     lint-thresholds-imports.mjs, lint-fixture-pii.mjs)
.claude/skills/
  mine-corrections/  Skill driving the corrections LLM stages
  mine-decisions/    Skill driving the decisions LLM stages (stub UI
                     until LLM pipeline lands; see Phase Rev3-F)
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

Wipe coverage: the `/api/clear` POST handler explicitly extends the
orphan-sweep into the new SQLite substrate (Rev3-A.A9 promise) —
it calls `closeChatArchDb()` to release the OS file handle, then
`wipeSqliteDbFiles()` to unlink the `.db` + `.db-wal` + `.db-shm`
siblings, BEFORE delegating to `clearDataDir.ts`'s `wipeAll` /
`wipeSources` for the JSON-sidecar tree. `wipeAll` itself does NOT
reach the DB (the DB lives under a sibling of `public/`, not under
it) — the endpoint composes the two paths. Next `getChatArchDb`
call re-opens, re-runs migrations on the empty DB, and re-folds any
legacy JSON sidecars if they survived the sweep.

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

### Outcome-substrate sidecars (Phase 1-4, EXPORTER_VERSION 1.2.0)

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
