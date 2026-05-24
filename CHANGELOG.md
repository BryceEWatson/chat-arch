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

- **SQLite-backed entity-states ledger (Phase Rev3-C C4).** The
  entity-states ledger introduced in C1+C2 (PR #70) now persists to
  a new `entity_states` SQLite table instead of the JSON sidecar.

  Components shipped:
  - **Migration 003 (`entity_states` table)** with composite PK
    `(entity_kind, entity_id)`, CHECK constraints on `entity_kind` /
    `state` / `dismissal_count`, and a descending `updated_at` index
    for fast "most recent first" lists.
  - **SDK module `packages/exporter/src/db/sdk/entityStates.ts`**
    exposing `getEntityState` / `listEntityStates` /
    `upsertEntityState` / `deleteEntityState`. The upsert runs the
    whole read-old + compute-counter + write sequence inside a single
    `BEGIN IMMEDIATE` transaction so concurrent writers can't tear
    the dismissalCount semantics established in C1+C2 iter-1.
  - **New `@chat-arch/exporter/db` subpath export** so the standalone
    Astro app can import just the substrate primitives (connection +
    migrations + SDK) without pulling in the source-specific export
    modules.
  - **Standalone DB connection helper** at
    `apps/standalone/src/lib/chatArchDb.ts` — process-lifetime cached
    handle that lazy-opens, runs migrations, and folds any pre-
    existing legacy JSON ledgers (v1 `knowledge-debt-states.json` +
    v2 `entity-states.json` from C1+C2) into the SQLite table on
    first access. Folded files get renamed with a
    `.migrated-to-sqlite` suffix so a user inspecting the data dir
    post-migration can see what happened.
  - **Endpoint cutover** — `apps/standalone/src/pages/api/
    entity-states.ts` POST now writes through the SDK. The GET path
    grew an `entries: EntityStateEntry[]` field so the viewer client
    can read the full ledger from the API instead of the static JSON
    file.
  - **Viewer client API-first read ladder** — `loadEntityStates`
    fetches `/api/entity-states` first, falls back to the v2 JSON
    sidecar (PR #70 path), then to the legacy v1 sidecar (pre-PR-#70
    path). All three rungs preserve user state across the C1→C2→C4
    rename + persistence cutover.

  Tests: 11-test SDK round-trip suite covering upsert / get / list /
  delete + the Closure-B dismissalCount auto-increment semantic +
  composite-PK independence. 7-test migration suite covering CHECK
  constraints + PK uniqueness + index registration. 8-test fold suite
  covering v1+v2 JSON migration, malformed-entry drops, non-clobbering
  collision behavior, and a path-discipline regression that asserts
  the DB file lives OUTSIDE `apps/standalone/public/` (Astro would
  otherwise serve the binary DB as a static asset — see the security
  note below).

  **Path discipline (security fix between iter-1 and iter-2).** The
  SQLite DB lives at `apps/standalone/chat-arch-data/chat-arch.db` —
  a SIBLING of `public/`, NEVER inside it. Astro's `public/` is
  served verbatim at the URL root; a DB under `public/` would be
  reachable at `/chat-arch-data/chat-arch.db` and expose the entire
  ledger to anyone who can reach the dev server. The connection
  helper relocates an existing legacy-path DB on first boot so anyone
  who ran an earlier iteration of this branch keeps their state.

  **Rollback note.** This migration is forward-only. Reverting past
  this PR means any post-cutover writes survive only as orphan rows
  in `apps/standalone/chat-arch-data/chat-arch.db`; the JSON sidecars
  remain renamed as `entity-states.json.migrated-to-sqlite` /
  `knowledge-debt-states.json.migrated-to-sqlite`. To restore the
  pre-C4 JSON-only flow, rename the `.migrated-to-sqlite` files back
  and discard the SQLite DB.

- **`narrative` ack kind (Phase Rev3-C C3).** Adds `'narrative'` to
  `apps/standalone/src/pages/api/insights-ack.ts`'s `KNOWN_KINDS`
  allow-list. Lets the existing binary-ack ledger record one-shot "I've
  seen this Narrative" actions. The richer state machine for narratives
  (PENDING / INSTALLED / DISMISSED + dismissalCount + growth-multiplier
  re-promotion) continues to live in the entity-states ledger
  (`/api/entity-states`, added in C1+C2). Two surfaces on purpose: the
  ack endpoint stays as a thin idempotent ack, while entity-states
  handles the multi-state lifecycle.

- **Entity-states ledger (Phase Rev3-C C1+C2).** New endpoint
  `/api/entity-states` writes to `analysis/entity-states.json` (v2
  shape) keyed by composite `(entityKind, entityId)`. Generalizes the
  prior `/api/knowledge-debt-state` ledger over both `knowledge-debt`
  clusters AND `narrative` entities under one entry shape, in
  preparation for Closure A wiring (Rev3-C C3+C4: surfacing dismiss /
  re-promote affordances on Narratives via the same growth-multiplier
  mechanism that already governs knowledge-debt clusters).

  Back-compat read: when `entity-states.json` is absent the server
  reads the legacy `analysis/knowledge-debt-states.json` and folds its
  entries into v2 in-memory (entityKind synthesized to
  `'knowledge-debt'`). The viewer client mirrors the same fallback so
  pre-existing local state survives the rename even before the user
  triggers a fresh write. The legacy file is left in place until the
  first action triggers a v2 write; from that point on the v2 file is
  authoritative and the legacy file is orphan (swept by NuclearReset's
  recursive `analysis/` wipe).

  Schema:
  ```
  EntityStatesFile { schemaVersion: 2, generatedAt, entries }
  EntityStateEntry {
    entityKind: 'knowledge-debt' | 'narrative',
    entityId: string,
    state: 'PENDING' | 'INSTALLED' | 'DISMISSED',
    updatedAt: number,
    sizeAtState: number,   // sessionIds.length for clusters,
                           // evidence.length for narratives
  }
  ```

  Removed: `apps/standalone/src/pages/api/knowledge-debt-state.ts`,
  `packages/viewer/src/data/knowledgeDebtStateClient.ts`, and the
  legacy test. `InsightsMode.tsx` now reads/writes through the new
  client with `entityKind: 'knowledge-debt'` baked in.

  Tests in `apps/standalone/test/api/entity-states.test.ts`:
  validation for both kinds, upsert composite-key non-collision,
  legacy-fallback migration, malformed-legacy-entry drop, v2-wins
  precedence.

- **Narrative-preview PII default-blur (Phase Rev3-B B9 — closes
  Rev3-B).** New `packages/viewer/src/components/BlurredPii.tsx`
  wraps prose-bearing narrative fields with a CSS blur + an
  on-click reveal toggle. The blur is purely visual — the underlying
  text remains in the DOM so screen-readers + search-on-page still
  work, with an aria-live announcement of the blur state so
  keyboard-only users discover the reveal button without first
  finding the blurred prose.

  Wired into `packages/viewer/src/components/modes/ProjectsMode.tsx`:
  - Narrative `title` wrapped in `BlurredPii label="narrative title"`.
  - Narrative `body` wrapped in `BlurredPii label="narrative body"`.
  - The article's `aria-label` no longer leaks the title (changed
    from `"${sentiment} narrative: ${title}"` to
    `"${sentiment} narrative (title PII-blurred until revealed)"`).
  - Evidence pill `title` hover-tooltip no longer leaks the excerpt
    (was `e.excerpt ?? label`; now just `label`). The full excerpt
    surfaces via the reveal-toggled body, not via hover.

  Reveal state is per-component-instance (not persisted) by design:
  closing and re-opening a card re-blurs. Persisting would defeat
  the "default safe" framing; a future "always reveal" workspace
  preference could land separately if the friction is too high.

  9 tests in `BlurredPii.test.tsx`: blurred-by-default with content
  in DOM, aria-hidden on blurred content, Reveal button labeling,
  click-to-reveal state flip, click-to-hide flip-back, default
  "PII content" label, `initialRevealed` test hook, className
  passthrough, screen-reader-only state announcement.

  CSS in `packages/viewer/src/styles.css` — `filter: blur(4px)` on
  the blurred state, with `user-select: none` to prevent
  accidental copy-paste of blurred text.

- **Narrative provenance backfill kernel (Phase Rev3-B B5).** New
  module `packages/exporter/src/db/backfillNarrativeProvenance.ts`.
  One-shot promotion of legacy schemaVersion=1 narrative rows to
  schemaVersion=2 with provenance fields populated. For each v1 row:
  - `supportingCount` = `COUNT(*)` of `narrative_evidence` rows.
  - `contradictingCount` = 0 (no legacy contradiction info).
  - `confidence` = `computeConfidence(supportingCount, 0,
    THRESHOLDS.narrativeRung.defaultPrior)`.
  - `attributedTo` = `'deterministic'` per plan §B5.
  - `provenance` = synthesized placeholder (`intent:
    'legacy-v1-backfill'`, `observation: title[0..200]`, `inference:
    body[0..200]`). Future kernel re-runs overwrite with real
    provenance.
  - `schema_version` = 2.

  All writes happen inside a single `withWriteTransaction` for
  atomicity. Idempotent — second call promotes 0 (the `WHERE
  schema_version = 1` filter excludes already-backfilled rows).
  Pure (no `Date.now()` / PRNG / external I/O); same DB state in →
  same DB state out.

  7 new tests in `backfillNarrativeProvenance.test.ts` against the
  PR #60 seeded fixture (4 v1 narratives + 1 v2 narrative): one-call
  promotion, idempotency, provenance/attributedTo/confidence
  population, supportingCount equals evidence-row count,
  confidence matches computeConfidence formula, empty-DB no-op,
  observation/inference truncation at 200 chars (placeholder
  PII boundary).

- **Narrative confidence-ladder helpers (Phase Rev3-B B6 + B7).**
  New module `packages/analysis/src/narrativeRung.ts` exports:
  - `computeConfidence(supporting, contradicting, prior)` — the
    Bayesian Beta-posterior mean form pinned by
    `THRESHOLDS.narrativeRung` (`supporting / (supporting +
    contradicting + prior)`). Returns NaN on invalid inputs;
    clamps to `[0, 1]`.
  - `effectivePriorForKernel({ kernel, calibrationCompletedAt })`
    — B7 calibration fail-safe. Returns `uncalibratedPrior` (20)
    when `calibrationCompletedAt == null`; else
    `priorByKernel[kernel] ?? defaultPrior` (2). Cold-start
    protection: an uncalibrated kernel can't promote a finding
    to tier-3 on its first few observations.
  - `narrativeTier(confidence, supporting, contradicting)` — joint-
    gate dispatcher returning the highest reachable tier (0–3) per
    the floor / supporting-count / (tier-3-only) contradicting-cap
    rules in `THRESHOLDS.narrativeRung`. Single source of truth
    for tier decisions; callers should NEVER inline the threshold
    comparisons.
  - All three re-exported from `@chat-arch/analysis`.

  18 new tests in `narrativeRung.test.ts` cover the joint-gate
  feasibility proof (the PR #58 contract that tier3=0.66 + count
  cap is satisfiable at supporting=6, contradicting=1, prior=2 →
  6/9=0.667 ≥ 0.66), the cold-start protection (uncalibrated +
  moderate evidence can't reach tier-3), end-to-end equivalence
  (calibrated kernel + tier-3 minimum count DOES reach tier-3),
  invalid-input fallbacks, and the tier-2-fallback when contradicting
  exceeds the cap.

- **Narrative provenance schema (Phase Rev3-B B1+B2+B3+B4+B8).**
  `packages/schema/src/narrative.ts` extends the `Narrative` type
  with optional `schemaVersion`, `provenance` (intent/observation/
  inference), `attributedTo`, `verifiedAt`, `confidence`,
  `supportingCount`, `contradictingCount`, and `correlatedOutcome`
  fields. `NarrativeEvidence` gains optional `turnIndex` (0-based
  message ordinal). `validateNarrative` runs the pre-existing
  invariant checks on both schema versions and additionally enforces
  the v2 shape (non-empty provenance, attributedTo, confidence in
  [0,1], non-negative counts) when `schemaVersion === 2`. v1 rows
  remain accepted untouched for the legacy on-disk corpus.

  DB migration `002-narrative-provenance.ts` adds the matching nullable
  columns to `narratives` (`intent`, `observation`, `inference`,
  `attributed_to` with CHECK on the 4-value union, `verified_at`,
  `confidence` with CHECK 0–1, `supporting_count`/`contradicting_count`
  with CHECK ≥ 0, `correlated_outcome_json`) and `turn_index` to
  `narrative_evidence` (CHECK ≥ 0). Existing rows survive with all
  new columns NULL — equivalent to schemaVersion=1. The schema-layer
  `schema_version` column already exists from migration 001 with
  DEFAULT 1; migration 002 only adds the provenance siblings.

  Gate test `packages/schema/src/narrative.migration.test.ts` (16
  cases) covers: v1 acceptance with/without explicit schemaVersion,
  v1 still rejects pre-Rev3-B invariant violations, v2 acceptance
  for the full provenance shape, v2 acceptance of verifiedAt=null
  + correlatedOutcome=null + all 4 attributedTo values, v2 structural
  rejections (missing provenance / empty triple / missing
  attributedTo / out-of-range confidence / negative counts), unknown
  schemaVersion rejection, and turnIndex round-trip on evidence.
  DB-side migration test `002-narrative-provenance.test.ts` (7 cases)
  exercises the SQL CHECK constraints + a v1 legacy insert + a full
  v2 insert with correlated_outcome_json JSON round-trip + the
  evidence.turn_index optional+CHECK behavior.

### Changed

- **`attachIfBusy` refactored to named function with explicit deps
  object (tech-debt XN3).** The on-page-load handler that re-attaches
  to in-flight mining runs in [`apps/standalone/src/pages/index.astro`]
  was previously a 40-line IIFE closing over module-scope state. It's
  now a named function (`attachIfBusy(deps)`) with dependencies
  surfaced in one place — `showProgress`, `setButtonsDisabled`,
  `startElapsedTicker`, `pollMineStatus`, `setStatus`, `hideProgress`,
  `reloadSoon`, `setStatusPollTimer`, `clearStatusPollTimer`. The
  script tag stays `is:inline` (Vite doesn't process inline scripts),
  but the explicit-deps shape prepares a future module extraction to
  lift the function verbatim. Same runtime behavior; no behavior
  change.

### Added

- **`cosineSimilarity` triplication consolidated (tech-debt D2).**
  The previously-triplicated cosine implementations now live in
  `packages/analysis/src/stats.ts`:
  - `cosineSimilarity(a, b)` — general form with magnitude division
    (replaces the byte-identical copies in `clusterRules.ts` and
    `embeddings/index.ts`).
  - `cosineSimilarityNormalized(a, b)` — fast-path dot product for
    pre-normalized inputs (relocated from `classifyByEmbedding.ts`).
  - New `NumericVector` type — `Float32Array | Float64Array |
    readonly number[]`.
  Existing imports continue to work via re-exports from
  `classifyByEmbedding.ts` and `embeddings/index.ts`. Behavior
  byte-identical to pre-D2 main; pure consolidation.
- **Fisher's exact at small-n in surface-comparison (tech-debt T3).**
  `SurfacePairwiseTest` now carries a `testMethod: 'z-test' |
  'fisher-exact'` field, and per-pair test selection in
  `surfaceComparisonBuilder` follows the canonical small-sample rule:
  use Fisher's exact two-sided test when any expected cell count
  falls below 5 (where the pooled-z normal approximation is
  unreliable); otherwise use the existing z-test. Pairs in the same
  family can mix methods — the choice is per-pair, not global.
  **Behavior change for re-runs**: existing `analysis/surface-
  comparison.json` files re-generated against current chat-arch-data
  may show flipped significance verdicts on small-cell pairs (some
  previously-significant pairs become non-significant once Fisher
  exact's more conservative tail probability replaces the z-test;
  occasionally the reverse). The verdict change reflects more
  accurate inference, not a regression. Run `pnpm exporter run
  start` to regenerate.
  New helpers in `@chat-arch/analysis`:
  - `fisherExactPValue2x2(a, b, c, d)` — two-sided "minlike" Fisher
    exact via hypergeometric log-probabilities + logsumexp accumulator
    (numerically stable for N well beyond what chat-arch surfaces).
  - `expectedCellCounts2x2(nA, nB, goodA, goodB)` — returns the four
    expected cell counts so callers apply the < 5 gate uniformly.
- **McNemar test in reflexive matched-pair contrast (tech-debt T2).**
  `ReflexiveResult` now carries `mcnemarP`, `mcnemarMethod`
  (`'exact'` | `'chi-squared'` | `'undefined'`), and `discordantCount`
  fields. McNemar respects the pairing in a way the existing
  two-proportion z-test on `delta` does not — pair-level concordant
  outcomes contribute no information about the treatment effect, so
  only the `b + c` discordant pairs drive inference. Exact binomial
  test when `b + c < 25`; continuity-corrected χ² with 1 df otherwise.
  Surfaces in `analysis/reflexive.json`; viewer methodology disclosure
  can show "tested on N discordant pairs" alongside the existing
  e-value sensitivity analysis.
- **Linear-trend pre-detrending in Politis-White block-length selector
  (tech-debt T4).** `politisWhiteBlockLength(xs, { detrend? })` now
  defaults to detrending via Theil-Sen slope + median-residual
  intercept before computing autocovariances. A trended series
  inflates low-lag `R(k)` (the autocov picks up the trend, not
  residual autocorrelation), which pushes the selected block length
  higher than the true correlation horizon warrants. The detrended
  pre-step keeps `R(k)` reflecting residual autocorrelation only.
  Pass `detrend: false` to restore the pre-T4 behavior for legacy
  comparison; not recommended for new analyses. Affects
  `analysis/project-trajectories.json` CIs — they should narrow on
  trended projects (more accurate variance estimate).
- **BH-FDR correction in ITS analysis (tech-debt T1).** `ItsResult`
  now carries `pValue` (raw pooled two-proportion z-test of post vs.
  pre good-share) and `qValue` (Benjamini-Hochberg adjusted across
  all commits in the same `runItsAnalysis` call). On-disk shape of
  `analysis/its-analysis.json` gains both fields; consumers should
  gate "significant change" claims on `qValue ≤ α` rather than the
  raw `pValue`. NaN passes through for commits where either pre/post
  window is empty (no test is meaningful).
- **Silhouette gate in `detectArchetypes` (tech-debt T5).** The
  `silhouetteFloor` option (existed but was unwired) now actively
  gates output: when the best k's silhouette score falls below the
  floor (default `THRESHOLDS.clustering.silhouetteMin = 0.15`), the
  kernel returns empty centroids + null assignments while still
  reporting the observed best silhouette + chosen k (so a viewer
  banner can surface "no signal at silhouette X.XX" rather than
  silently showing nothing). `ArchetypesResult` doc now enumerates
  the three "empty centroids" cases callers can distinguish via
  `chosenK` + `silhouette`.
- **Centralized statistical helpers in `packages/analysis/src/stats.ts`.**
  `normalCdf`, `twoProportionPValue`, `bhFdrAdjust` exported from the
  package index. `surfaceComparisonBuilder.ts` and `skillCurve.ts`
  both now consume from the centralized module; their inline copies
  removed. The previously-exported `benjaminiHochberg` from
  `skillCurve.ts` is replaced by `bhFdrAdjust` (rename + relocate).

### Fixed

- **`normalCdf` bug in `surfaceComparisonBuilder.ts`.** The inline
  implementation returned `erf(x)` instead of `Φ(x)` — a missing
  `/√2` argument scaling — causing `twoProportionPValue` to
  over-reject (treat z=2.0 as p≈0.005 when the true two-sided p
  is ≈0.046). All cached `analysis/surface-comparison.json` files
  produced by `EXPORTER_VERSION = 1.2.0` will have inflated
  significance counts; regenerate via `pnpm exporter run start`
  to pick up the correct p-values. The `skillCurve.ts` inline copy
  was already correct; only `surfaceComparisonBuilder` was affected.

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
