# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project loosely follows [Semantic Versioning](https://semver.org/)
at the **exporter-data layer** (the `exporterVersion` field in
`analysis/meta.json`). Individual workspace packages are private and
stay at `0.0.0`; the exporter version is the user-facing artifact
contract.

The version label appears at the top of `analysis/meta.json` after each
rescan, so anyone inspecting a chat-arch-data bundle can correlate the
on-disk shape with this changelog.

## [Unreleased]

### Added

- **SQLite substrate foundation (Rev3-A.A4 + A5 + A6).** New module
  at `packages/exporter/src/db/`:
  - `connection.ts` — `openDb(path, { readonly? })` applies the
    four-pragma contract from the Rev3 plan §"SQLite write contract"
    (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
    `busy_timeout=0`).
  - `transaction.ts` — `withWriteTransaction(db, work)` wraps
    `BEGIN IMMEDIATE` … `COMMIT` with explicit `SQLITE_BUSY` retry
    (50 ms initial backoff, doubles per retry, 1 s total budget;
    throws `WriterBusyError` past budget).
  - `migrations/` — idempotent runner backed by a `schema_migrations`
    ledger. Each migration runs inside its own `BEGIN IMMEDIATE`; a
    failed `up()` rolls back AND leaves the ledger unchanged so the
    next call retries. Registry order is the apply order. New
    `assertMigrationIdsLexSorted()` defends against
    parallel-branch id collisions.
  - `001-initial-schema.ts` — first migration. 14 tables matching the
    existing TS entity types (analyzers, projects, topics, sessions,
    session_messages, session_revisions, narratives,
    narrative_evidence, narrative_sessions, patterns, project_sessions,
    project_topics, topic_sessions, findings) + 10 indexes for the
    hottest query paths. Composite session FK on `(source, id)`
    propagates through evidence + sessions junctions. The `findings`
    table carries optional FK anchors for every entity kind, gated
    by a CHECK on the session composite key (both-or-neither).
  - 5 test files (connection, transaction, runner, initial-schema)
    covering pragmas, FK enforcement, CASCADE / SET NULL, busy-retry
    success + exhaustion, idempotency, partial-state rollback,
    migration-order invariant.

  Wired by nothing yet — Phase Rev3-B kernels move onto SQLite. The
  existing JSON-sidecar pipeline is unchanged.

### Added

- **NDJSON streaming progress widget** on the Today page for rescan /
  mine-corrections / regen-brief actions — spinner, elapsed ticker,
  phase labels, scrollback log, `attachIfBusy()` resume-on-load.
- **DataDirGuard** at `apps/standalone/src/lib/dataDirGuard.ts` — path-
  traversal containment check wired into mine-corrections (POST + GET),
  mine-decisions, and generate-exports. Returns 400 on traversal.
- **`THRESHOLDS.practiceAudit`** group — three PRACTICE-audit knobs
  (`valueLeakDuplicateMinSize`, `topCostOutliers`, `turnOutlierMin`)
  moved out of inline constants in the viewer.

### Fixed

- **Security (S1):** dataDir path-traversal across three API endpoints.
- **Security (S2):** drop verbatim `gh` CLI stderr from
  `pr-land-cache.json` — `state` enum is sufficient for cache TTL.
- **Security (S3):** stamp atomic-write `.tmp` filenames with
  `${pid}-${Date.now()}-${rand6}` so concurrent writers can't race.
- **Security (S4):** `apply-correction.ts` outer catch now resolves the
  slot promise with 500 instead of rejecting + rethrowing (was
  triggering Node 15+ unhandled-rejection process exit).
- **Security (S5):** drop `cmd.exe /d /s /c` shell-injection path in
  mine-corrections and mine-decisions — `spawn(bin.file, args, …)` via
  the central resolveClaudeBin() helper instead.
- **`resolveClaude.ts`:** add `CLAUDE_CODE_EXECPATH` probe between
  `CLAUDE_BIN` and the `%APPDATA%\Claude\…` fallback.

## [1.2.0] — 2026-05-23

### Added

- **Outcome-substrate roadmap (Phases 1-4).** Per-session
  `CompositeOutcome` score with embedded weights + `weightsHash`
  for refit-aware caching. Eleven new gitignored analysis sidecars:
  `composite-outcomes.json`, `pr-land-cache.json`,
  `config-history.json`, `its-analysis.json`, `knowledge-debt.json`
  (+ `chat-arch-data/exports/knowledge-debt.md`), `reflexive.json`,
  `decisions.json`, `archetypes.json`, `project-trajectories.json`,
  `surface-comparison.json`, `skill-curves.json`.
- **Six new viewer modes**: Effectiveness, Insights, Decisions,
  Trust, Trends, Export. Each ships a `MethodologyDisclosure`
  panel + `SourceAttribution` cell-level honesty labels.
- **Audit-config extensions**: six new claim families
  (`gh-pr-opened` / `gh-pr-merged` / `gh-pr-closed-unmerged` /
  `git-revert` / `git-reset-hard` / `git-force-push`) and a
  positive-polarity `AFFIRMATION_PATTERNS` family.
- **THRESHOLDS registry** at `packages/analysis/src/thresholds.ts`.
  Lint script `lint:thresholds-imports` flags bare numeric literals
  outside that file.
- **`/api/generate-exports`** endpoint + `packages/exporter/src/
  export/` submodule for Obsidian-targeted post-mortems and
  knowledge-debt exports.
- **Phase 4 thrash detector** PostToolUse hook (under
  `~/.claude/skills/chat-arch-thrash-detect/`, NOT in-repo) gated
  on `CHATARCH_THRASH_DETECT=1` for a 4-week calibration window.

## [1.1.0] — 2026-05-18

### Added

- **AppSidebar** — collapsible left-rail primary nav grouped
  WORKSHOP / TRACK / BROWSE / SYSTEM. Replaces the horizontal
  TodayNav (which now redirects).
- **RESULTS surface** at `/results` — cross-corpus claim-pass
  rate by claim type / project / session + loop-closure rollup.
- **PLAYBOOK surface** at `/playbook` — recurring user-turn
  phrasings ranked by occurrence × downstream pass-rate; COPY AS
  MARKDOWN handoff for blog-post drafting.
- **`/api/regen-brief`** endpoint behind the Today-page "REGEN
  BRIEF" action button.

### Fixed

- Pre-existing TrustStrip apostrophe-escape lint errors.

## [1.0.0] — 2026-05-16

### Added

- **chat-arch v2 — instrumented AI collaboration loop.** Single PR
  delivering the four-layer stack (B/A/F/D) defined in
  `research/v2-instrumented-loop.md`. Wave 1 (foundation) headlines:
  - **Embeddings substrate** (§4). Local Ollama with
    `nomic-embed-text` (768-dim) drives every layer above the
    foundation. New `analysis/embeddings.bin` (concatenated LE
    float32) + `analysis/embeddings.meta.json` (sessionId → byte
    offset). Incremental — sessions whose `sourceMtimeMs` is
    unchanged reuse their prior vector. Fail-soft when Ollama is
    unreachable: warn-once + skip, never block the rescan. New
    `pnpm exporter embed [--only-changed|--no-only-changed]
    [--model] [--base-url]` sub-command. Auto-runs at the tail of
    `pnpm exporter all`.
  - **`UnifiedSessionEntry.discoveryScore?: number`** (0–1) on
    schemaVersion 4. Computed offline from token intensity, tool
    diversity, correction-applied-after, and gitBranch → PR overlap.
    Drives blog-draft candidate selection.
  - **`schemaVersion` bumped to 4.** v1/v2/v3 manifests still parse
    (back-compat AC); `analysisSidecars` grows pointer slots for
    every new v2 sidecar (embeddings, continuum-health, semantic
    duplicates, audit-claims/results/summary, upgrade-outcomes,
    blog-candidates, blog-drafts index).
  - **`analysis/continuum-health.json`** (§5 B.1 / B.2). Per-source
    capture-rate warnings, `consecutiveSuccesses` streak, and
    `entriesByStatus` distribution. Surfaced in the viewer footer
    + the daily brief's "Continuum health" section. Documented
    nightly-scan routine for the `schedule` skill at
    `_planning/v2-wave1-schedule.md`.

### Changed

- `EXPORTER_VERSION` bumped from `0.10.0` → `1.0.0`. Trips
  per-source cache-bust on next rescan (every cached entry is
  re-emitted under the new schema).

## [0.10.0] — 2026-05-15

### Added

- **`sessions-index.json` ingestion** — the host-CLI walker now reads
  Anthropic's per-project `sessions-index.json` and reconstructs
  lightweight `UnifiedSessionEntry`s for sessions whose `.jsonl` has
  already been pruned from disk. New `transcriptStatus: 'pruned'`
  distinguishes them. `userTextSamples` is populated from the index's
  `firstPrompt` so `discoverNarratives` still gets clustering input.
- **WSL CLI scanning (Windows host)** — the `cli` and `all` subcommands
  now enumerate WSL distros via `wsl --list --quiet` and walk
  `\\wsl.localhost\<distro>\home\<user>\.claude\projects\` for each one
  via UNC. `docker-desktop` and other system distros are skipped.
  Failures (no WSL installed, unreachable distro) are warn-once'd and
  the rest of the scan continues.
- **`additionalProjectsRoots` option on `runCliExport`** so other
  callers can feed extra CLI roots without round-tripping through the
  WSL discovery code (e.g., future macOS / Linux native scans).
- **`prunedCount` on `CliExportResult`** — reported in the `all`
  summary alongside the rescanned/reused counts.

## [0.9.0] — 2026-05-15

### Added

- **Subagent rollup** — Cowork and host-CLI sessions whose Task tool
  fans out to sub-agents (often Haiku) now contribute the sub-agents'
  tokens, tool calls, and models to the parent entry's
  `tokenTotals` / `topTools` / `modelsUsed`. The sub-agent-only
  breakdown stays inspectable via the new `subagentRollup` field.
- **`userTextSamples`** — every source now emits up to 5 user-turn
  excerpts (≤400 chars each) for analysis-grade input. Feeds
  `discoverNarratives` clustering so the pipeline sees more than the
  200-char `preview`.
- **Inline Cowork enrichments** — `userSelectedFolders`,
  `slashCommands`, `enabledMcpTools`, `errorMessage` are now exposed
  on the unified entry instead of being dropped at the
  drift-detection stage.
- **`tokenTotals` on Cowork entries** — derived from
  `audit.modelUsage`; previously absent.

### Changed

- **`claude-code-sessions/` routed through Cowork** — Anthropic's
  rename (refs anthropics/claude-code#29373, #27463) means both
  AppData roots are now Cowork-shaped. The Desktop-CLI walker is
  removed; a warn-once fires if a manifest there matches neither
  schema.
- **Per-source cache envelope** — `cli-sessions.json` and
  `cowork-sessions.json` now write
  `{ __exporterVersion, entries }`. Loaders gate reuse on an exact
  version match so on-disk-shape changes self-invalidate. Legacy
  bare-array files are tolerated for one rescan cycle.

## [0.8.0] — 2026-05-08

### Added

- **Applied-improvement ledger** — a new sidecar
  `analysis/applied-improvements.json` records every `ProposedUpgrade`
  the user has clicked APPLY on. The viewer merges it over
  `corrections.json` at read time so `applied`/`appliedAt`/
  `recurringPostApplication` reflect the user's actions, while
  `corrections.json` itself stays a pure mining-pipeline output (a
  re-mine never clobbers the apply history).
- **`POST /api/apply-correction` endpoint** writes the ledger.
  Idempotency key: `(patternId, proposedUpgrade.target,
  proposedUpgrade.targetPath)`. Re-applying replaces the prior entry.
- **APPLY button** in the corrections panel — replaces the placeholder
  disabled button. Inline confirm row → POST → "APPLIED ✓" pessimistic
  swap. Concurrent applies in one card are blocked while a write is
  in flight.
- **Instance clickthrough** — each instance excerpt in a correction
  pattern card is now a button that opens the source session in detail
  view, matching the Practice-mode evidence-pill pattern.
- **Persistent rescan-delta chip** — the rescan success banner gains an
  explicit ✕ dismiss button (no more 6s auto-vanish), per-source
  delta breakdown is logged to the activity log, and a `RESCAN: +N`
  TopBar chip persists until dismiss or the next rescan.

### Changed

- `EXPORTER_VERSION` bump (0.7.0 → 0.8.0) signals the new
  `applied-improvements.json` shape under `analysis/`. The file is
  optional — viewers older than this release ignore it cleanly.

## [0.7.0] — 2026-05-08

### Added

- **Corrections view** — a new viewer panel that surfaces recurring
  user-corrections-to-the-AI clustered into patterns, sorted into three
  buckets (`RECURRING AFTER APPLIED`, `ALREADY ENCODED BUT FAILING`,
  `NEW PATTERNS TO ENCODE`), and paired with proposed CLAUDE.md
  upgrades. The mining pipeline runs locally via the `/mine-corrections`
  Claude Code skill — no transcript ever leaves your machine.
- **Heuristic-recall layer** — `packages/analysis` ships a pure
  pattern-detection kernel (`detectCorrectionCandidates`) that scans
  user turns for correction signals (`explicit-stop`, `explicit-no`,
  `instead-of`, `imperative-override`, `frustration`,
  `repeat-instruction`, plus the new `soft-redirect` and `want-prefer`
  families added in v0.7.0). The exporter calls it during `runAnalysis`
  and writes `analysis/correction-candidates.json`.
- **Mining API endpoints** (dev server only):
  - `POST /api/mine-corrections` — drives the LLM classification +
    clustering stages of the corrections pipeline by spawning the
    `claude` CLI against the project's `.claude/skills/mine-corrections/`
    skill. NDJSON-streamed progress.
  - `POST /api/clear-corrections` — wipes `corrections.json` and any
    orphan run-status files. Leaves `correction-candidates.json` intact.
  - Both endpoints share the same CSRF posture as `/api/rescan`:
    local-origin check + custom `X-Requested-With` header.
- **Pipeline coverage UI** — every corrections panel now shows a
  classified-vs-total ratio bar plus an expandable funnel that tracks
  sessions → transcripts → user prompts → candidates → classified →
  actionable → patterns, with a `NOT SCANNED` callout for coverage gaps
  (sessions without transcripts, sources not loaded).
- **Recall-audit script** — `scripts/audit-correction-recall.mjs`
  spot-checks how many non-firing user turns carry weak correction
  signals the heuristic doesn't capture. Used during the v0.7.0
  expansion to validate the new pattern families.
- **Heuristic-version cache key** — `correction-candidates.json` now
  carries `heuristicRecallVersion: 2` and a per-session `scanStatsBySession`
  tuple. Pattern-set changes invalidate the cache; per-session stats
  preserve funnel-counter accuracy across incremental rescans.

### Changed

- **Heuristic-recall ruleset (v2)** — broadened the explicit-no
  negation regex (matches `don't/never` + any verb, not a small
  whitelist), added `soft-redirect` (`actually,` / `wait,` / `hmm,` /
  `let's …`) and `want-prefer` (`I want / need / prefer / I'd rather /
  I would like`) families, added `just|please` to the imperative-
  override family. Measured against a single 472-session author corpus
  via `scripts/audit-correction-recall.mjs`: candidate count on that
  corpus rose from 196 → 590 (about 3×) with most lift from
  `soft-redirect`, broadened `explicit-no`, and `want-prefer`.
  Per-corpus results will vary — re-run the audit script to see your
  own numbers.
- **Corrections panel readability pass** — bumped body-text
  transparencies from the 50-82% tier to 88-95% across all paragraphs,
  notes, captions, and instance excerpts. Body font sizes nudged up by
  0.5-1px on the smallest items. Line-length capped at 78ch on
  paragraph blocks. No palette or chrome changes.
- **Status-file polling for in-flight runs** — the mining banner now
  polls `${dataDir}/analysis/correction-status-${requestId}.json` while
  a run is active, so phase / current-of-total / log lines surface in
  real time rather than waiting for the headless `claude -p` to finish.
- **In-flight attach** — when the panel mounts and detects a run is
  already in progress (page reload, second tab, prior 409), it now
  attaches to the existing run by polling its status file rather than
  surfacing a 409 error. The probe response includes `busyRequestId`.

### Performance

- **Incremental corrections scan** — the heuristic-recall pass now
  reuses prior candidates for sessions whose `updatedAt` predates the
  prior file's `generatedAt`. On the same 472-session author corpus
  used for the recall audit, a warm rescan (no sessions changed) ran
  in ~5ms vs. ~18s previously; cold rescans (after a heuristic-
  version bump or fresh corpus) ran in ~1.5s on that corpus due to
  the parallel I/O change below. These are single-machine, single-
  corpus measurements — magnitude of the speedup is what matters,
  not the specific numbers.
- **Parallel transcript I/O** — `buildCorrectionsCandidatesFile` reads
  transcripts via an 8-way worker-pool (`parallelMap`) instead of a
  serial `for await` loop. Cold rescan I/O bucket dropped ~12×.

### Documentation

- This changelog.
- README updated to describe the corrections view and the local
  mining pipeline.

[Unreleased]: https://github.com/BryceEWatson/chat-arch/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/BryceEWatson/chat-arch/releases/tag/v0.7.0
