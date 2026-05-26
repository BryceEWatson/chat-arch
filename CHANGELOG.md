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

## [1.7.0] — 2026-05-26

Narrative-mining V1 — per-project LLM-driven thematic narratives,
automatically generated on every SCAN as the 6th chain step (after
`/mine-persona`). The existing deterministic kernel
(`packages/analysis/src/discoverNarratives.ts`) stays as the always-on
tier-1 baseline; LLM rows land alongside the heuristic rows in the
shared `analysis/narratives.json`, distinguished by `attributedTo:
'llm-derived'`. Projects with ≥ `THRESHOLDS.narrative.minSessionsForLlm`
(default 20) get 3-8 LLM-derived narratives with full provenance
(intent / observation / inference) and confidence-ladder participation.

### Added

- **`analysis/narrative-candidates.json`** — Stage-1 deterministic
  per-project candidate-evidence pool. Per-session candidates
  pre-bucketed by recency quartile (`founding` / `mid-early` /
  `mid-late` / `recent`), each carrying `{ sessionId, updatedAt,
  title, previewExcerpt, summaryExcerpt, sentimentPolarity,
  sentimentStrength, outcomeMarkers }`. The candidate is the SESSION
  (not the user turn — narratives describe session-level themes, not
  user-voice patterns). New builder at
  `packages/exporter/src/analysis/narrativeCandidates.ts`. Sampled
  stratified-by-recency up to `THRESHOLDS.narrative.maxSessionsForCorpus`
  (default 200), with a per-recency-bucket cap of 300 candidates.
  PII-bearing — gitignored under the
  `apps/standalone/public/chat-arch-data/*` wildcard.
- **Two additive optional top-level fields on `analysis/narratives.json`**:
  - `thresholds` — snapshot of `THRESHOLDS.narrative.*` so the viewer
    can disclose the calibration values the bundle was emitted under.
  - `skipped[]` — per-project skip rows (`insufficient-corpus` /
    `budget-exceeded` / `no-durable-themes` / `synthesis-failed` /
    `concurrent-rescan-aborted`) explaining why a project did NOT
    receive LLM enrichment this run.

  NO file-level `schemaVersion` bump (existing readers ignore unknown
  top-level keys; the row-level `schemaVersion` 1 | 2 from Rev3-B
  remains the load-bearing version axis). `EXPORTER_VERSION` 1.6.0 →
  1.7.0 is the auditable cutover marker.
- **`.claude/skills/mine-narratives/SKILL.md`** — Stage-2 LLM skill.
  4 parallel per-recency-bucket sub-agents per project + 1 synthesis
  sub-agent per project + deterministic Stage 2c stamping
  (`attributedTo: 'llm-derived'` / `confidence` / `actionType` /
  `schemaVersion: 2`) + `validateNarrative` drop + sessionId-membership
  hallucination guard + supportingCount floor + compare-and-swap on
  `generatedAt` for cross-writer concurrency.
- **`/api/mine-narratives` endpoint** — NDJSON-streaming endpoint
  driving the `/mine-narratives` skill. Tighter projectId sanitization
  than `/api/mine-persona` (regex
  `^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,126}[a-zA-Z0-9])?$` +
  manifest-membership check against `projects.json`). `REQUIRED_HEADER
  = 'chat-arch-mine-narratives'`. Silent-abort detection via
  `NarrativeOutcomeProbe` (BOTH status file `complete` AND fresh
  `narratives.json.generatedAt`).
- **`/api/clear-narratives` endpoint** — selective wipe: removes LLM
  rows + sweeps `narrative-status-*.json` + `narratives.json.tmp.*`
  orphans. Preserves heuristic rows + `thresholds` snapshot + unknown
  top-level fields (round-trip via `buildNarrativesFileObject`'s
  passthrough).
- **PROJECTS detail two-tier UI** — LLM-derived narrative cards
  render as primary (sorted by tier desc, confidence desc,
  supportingCount desc, generatedAt desc), with tier badge + collapsed
  provenance triple disclosure. Heuristic narratives collapse into a
  "Raw sentiment clusters (deterministic)" disclosure. Per-project
  "REGEN NARRATIVES" button. Skipped-row hint when a project has zero
  LLM rows AND a skip-row explaining why (NOT both card-render AND
  skip-listing).
- **`THRESHOLDS.narrative.*`** — new block with `minSessionsForLlm:
  20`, `maxSessionsForCorpus: 200`, `maxLlmUsdPerProject: 0.50`,
  `minPerProject: 3`, `maxPerProject: 8`, `evidenceMinPerNarrative:
  2`, `maxCandidatesPerRecencyBucket: 300`. **All pre-launch
  placeholders** — see Calibration notes below.

### Changed

- **`discoverNarratives` emission stamping** — heuristic rows now
  carry `attributedTo: 'deterministic'` + `schemaVersion: 1`. Legacy
  on-disk rows missing the field continue to read correctly via
  `normalizeNarrativeRow` (defaults to deterministic). The exporter's
  writer-side migration explicitly migrates the on-disk file on every
  rescan: read → classify families → merge → atomic write.
- **`narrativeTier()` signature** — extended with optional
  `opts?: { attributedTo?: NarrativeAttribution }`. When
  `opts.attributedTo === 'llm-derived'`, the returned tier is clamped
  to ≤ 2 (V1 cap — embedded in the function to preserve the
  "single point of truth" invariant). REMOVED in V1.1 when the
  contrary-evidence finder lands. Legacy callers without `opts`
  behave identically (back-compat).
- **SCAN chain — step count 5 → 6.** `FULL_SCAN_STEPS` appends a 6th
  entry for `/api/mine-narratives`. Sequential await — step 6 doesn't
  POST until step 5 (persona) closes.

### Calibration notes (placeholders flagged in [1.7.0])

Pre-launch values that need empirical calibration once V1 has corpus
data — calibrate against the same 4-week rolling window as
`CHATARCH_THRASH_DETECT`:

1. `THRESHOLDS.narrative.minSessionsForLlm = 20` — re-calibrate
   against hand-labeled narrative-usefulness ratings after the first
   10 personas + narratives co-emit.
2. `THRESHOLDS.narrative.maxLlmUsdPerProject = 0.50` — recalibrate
   after observing actual Stage-2 USD per project across 10 runs;
   set to the 95th-percentile observed cost. `candidateBudgetProxy`
   is DELIBERATELY ABSENT in V1 (unreachable as designed at
   `maxSessionsForCorpus=200` × 1 candidate/session); V1.1 may
   re-introduce a per-recency-bucket count gate once empirical
   candidate counts justify the bound.
3. `THRESHOLDS.narrative.minPerProject / maxPerProject = 3 / 8` —
   refit after hand-labeling 50 LLM narratives.
4. Confidence-ladder priors (`THRESHOLDS.narrativeRung.defaultPrior`
   interaction) — once 50 LLM narratives land, refit per the same
   calibration plan under `narrativeRung`.

### Known V1 limitations (deliberately deferred to V1.1)

- LLM rows are tier-capped at ≤ 2 (no `encode-as-pattern` action
  promotion). V1.1 lifts it when the contrary-evidence finder lands.
- `contradictingCount` is always 0 (no contrary-evidence finder).
- The SQLite `narratives` mirror is NOT updated by the skill — V1
  writes the sidecar only. V1.1 wires `insertNarrative` so MCP
  read-only consumers see LLM rows too.
- The `/falsify` skill does NOT yet verify LLM narratives' evidence
  chains. The `attributedTo: 'llm-derived'` field is the hookup; the
  V1.1 PR wires the call.
- REGEN is wipe-and-rewrite per-project — fresh UUID IDs per
  emission, not idempotent. V1.1 introduces a Stage-2 cache for
  diffability across runs.
- The Stage-2c pipeline bypasses `effectivePriorForKernel` (using
  `defaultPrior=2` directly) — a deliberate visibility-vs-safety
  trade-off. LLM rows surface at tier-2 immediately instead of
  tier-0 until calibration completes. Disclosed in
  `MethodologyDisclosure`.

## [1.6.0] — 2026-05-25

Persona-mining V1 — per-project data-grounded personas, automatically
generated on every SCAN as the 5th chain step. Models the
hand-authored `research/persona-evals/bryce.md` workflow as a general
feature: any project with ≥ `THRESHOLDS.persona.minSessionsForGeneration`
sessions gets its own persona under
`analysis/personas/<project-id>.md`, citing verbatim user-prompt
excerpts with `[SID:...]` anchors. Hand-authored personas under
`research/persona-evals/` stay canonical for the projects they cover.

### Added

- **`analysis/persona-candidates.json`** — Stage-1 deterministic
  heuristic extractor (new builder at
  `packages/exporter/src/analysis/personaCandidates.ts`). Per-project
  user-prompt excerpts bucketed into 6 heuristic categories:
  `role-expertise` / `preferences` / `project-specific` /
  `working-rhythm` / `frictions` / `voice`. Sampled by recency up to
  `THRESHOLDS.persona.maxSessionsForCorpus` (default 200), with a
  per-bucket cap of 40 candidates to bound the Stage-2 LLM input.
  PII-bearing — gitignored under the
  `apps/standalone/public/chat-arch-data/*` wildcard.
- **`analysis/personas.json`** — Stage-2 index. One record per
  project: `{ projectId, projectName, sessionsAnalyzed, sessionsTotal,
  personaPath, generatedAt, status, reason? }`. `status` is
  `generated` / `insufficient-corpus` / `budget-exceeded` / `error`.
  Written by the `/mine-persona` skill; preserved on per-project
  REGEN runs (merged in place, not overwritten wholesale).
- **`analysis/personas/<project-id>.md`** — per-project markdown
  persona, mirroring the structure of
  `research/persona-evals/bryce.md`: header / 6-10 numbered pattern
  sections with **Pattern.** / **Evidence.** (≥2 `[SID:...]`
  citations) / **What this implies.** / coverage notes. PII-bearing.
- **`/api/mine-persona`** — NDJSON-streaming endpoint (CSRF gate +
  inFlight serializer + spawn `claude -p` invoking the
  `mine-persona` skill). Mirror of `/api/mine-corrections`. Accepts
  `{ projectId? }` for per-project REGEN runs.
- **`/api/clear-personas`** — selective wipe for
  `analysis/personas.json` + `analysis/persona-status-*.json` +
  `analysis/personas/*.md`. Mirror of `/api/clear-corrections`.
- **`.claude/skills/mine-persona/SKILL.md`** — the Stage-2 LLM
  skill. Dispatches 4 sub-agents per project (one per time-bucket:
  founding / mid-early / mid-late / recent), then one synthesis
  sub-agent that writes the final markdown.
- **PERSONAS sidebar entry** under WORKSHOP (short label `PER`).
- **`/personas` page** — sidebar list of generated + skipped
  projects, body renders the active project's markdown with
  clickable `[SID:...]` anchors that navigate to
  `/sessions#session/<full-sid>`. Per-project REGEN button.
- **`THRESHOLDS.persona`** family:
  - `minSessionsForGeneration: 30` — below this, projects skip with
    `insufficient-corpus`.
  - `maxSessionsForCorpus: 200` — cap on what Stage 2 sees.
  - `maxLlmUsdPerProject: 0.5` — pre-flight budget guard
    (placeholder — V1 uses a candidate-count proxy; refine in V2).
- **5th SCAN chain step.** `FULL_SCAN_STEPS` extends to
  `[ rescan, mine, curate, falsify, persona ]`. Failure semantics
  unchanged.
- **`EXPORTER_VERSION` bumped 1.5.0 → 1.6.0**, recorded in
  `analysis/meta.json`.

### Out of scope (V1 — explicitly deferred)

- Cross-project composite persona.
- Persona-drift detection (diffing successive scans).
- Curator weighting by persona-derived preference vector.
- Persona-aware skill argument substitution.
- Falsifier extension to verify persona evidence citations
  (Stage-3 follow-up).
- Hand-authored `research/persona-evals/bryce.md` is NOT replaced —
  it stays canonical for the chat-arch project specifically; auto-
  generated output lives separately at
  `analysis/personas/chat-arch.md`.

## [1.5.1] — 2026-05-25

Auto-brief + SCAN-chain bug fixes.

### Fixed

- **Auto-brief was silently dropping 4 sections.** The daily-brief
  kernel grew 5 optional inputs (`shippedThisWeek`, `surprises`,
  `projectTrajectories`, `appliedPatternClosures`,
  `topStrongPositiveSurprise`) in the 1.4.1 → 1.5.0 window. The
  `/api/regen-brief` endpoint wired them; the exporter's auto-brief
  writer at `packages/exporter/src/analysis/semanticAnalysis.ts`
  did not. Every scan-time brief produced under 1.5.0 was missing
  the "Shipped this week", "Surprises today", "Project momentum",
  and "Applied-pattern closures" sections. This release wires
  `shippedThisWeek` + `surprises` + `projectTrajectories` through
  the auto-brief path. `appliedPatternClosures` remains `null`
  pending the `listWatcherVerdicts` SDK accessor (TODO at
  `semanticAnalysis.ts` ~ line 985, with companion TODOs at
  `dailyBrief.ts` ~ line 360 and `regen-brief.ts:193`). The brief
  kernel skips the section cleanly on null — same end-state as
  pre-fix for that one section, but the other three are restored.
- **SCAN chain occasionally halted at step 1.** The NDJSON parser
  in `apps/standalone/src/scripts/fullScan.ts` could swallow a
  terminal `done` event when the producer's final stdout chunk
  carried the event without a trailing newline (Windows stream-
  flush behavior under fetch). The post-stream drain now parses
  any unterminated trailing fragment in the buffer before
  reporting "stream ended without done."
- **Docstring drift in `fullScan.ts`.** Header comment said
  "4-step chain"; the array has been 5 since #102 (persona). Fixed
  to match.

### Why bump 1.5.0 → 1.5.1

Per the existing CHANGELOG precedent (1.4.0 → 1.4.1 in feed-redesign
Phase γ), brief-shape changes warrant a patch bump so consumers
inspecting `analysis/meta.json.exporterVersion` can correlate the
on-disk bundle with the fix.

### Known limitations

The fixed SCAN-chain halt is the most plausible root cause for the
symptom Bryce observed, but the original repro was not
deterministically captured before the fix. If post-merge SCAN still
halts at step 1, the new `console.warn` in the NDJSON drain path
surfaces the actual line that failed to parse — paste into a bug
report so the next iteration has ground truth.

## [1.5.0] — 2026-05-25

Feed-redesign Wave 2 #1 — delta surprises. The `computeSurprises`
kernel grows an optional `priorSurprises` input that, when provided,
unlocks five new surprise kinds that compare the current snapshot
against the most recent prior snapshot (loaded by the builder from a
new `analysis/archive/` sidecar family). On a first-ever scan no
prior exists and the delta kinds skip cleanly; the kernel's V1
snapshot behavior is byte-identical to the pre-bump output when
`priorSurprises === null`.

### Added

- **`analysis/archive/surprises-YYYY-MM-DD.json`** — per-scan
  snapshot of the surprises sidecar. Written by `surprisesBuilder`
  after each rescan via `atomicWriteJsonSync`. PII-bearing under the
  same rules as `surprises.json` itself (carries summary text +
  evidence session IDs). Covered by the existing
  `apps/standalone/public/chat-arch-data/*` gitignore wildcard.
- **Five delta surprise kinds** in the `computeSurprises` kernel:
  - `streak-extended` (positive) — current streak's terminal session
    matches prior's AND the run grew. Score = `clamp(diff/5, 0, 1)`.
  - `streak-broken` (concerning) — prior had a streak row, current
    does not. Score = `clamp(priorCount/10, 0, 1)`.
  - `trajectory-flip-up` (positive) — project was stalled / absent
    in prior, now accelerating. Score = `clamp(slope*10, 0, 1)`.
  - `trajectory-flip-down` (concerning) — mirror of flip-up.
  - `pattern-recurrence-resumed` (concerning) — pattern was
    `pattern-closed` in prior, `pattern-recurring` in current. Fixed
    score 0.85 (high-attention signal).
- **`THRESHOLDS.surprises.archiveRetentionDays = 30`** — filename-
  based prune horizon. Pre-launch placeholder; calibrate when the
  rescan cadence stabilizes (e.g. lower if user scans every few
  days, raise if multiple scans per day).
- **`loadMostRecentArchive` + `archiveAndPrune` helpers** exported
  from `surprisesBuilder.ts` so the per-scan archive lifecycle is
  unit-testable end-to-end.
- **UI mappings** for the five new kinds in
  `apps/standalone/src/pages/index.astro` (`SURPRISE_KIND_LABEL` +
  `SURPRISE_DRILL_IN`). Drill-ins reuse the parent surfaces of each
  snapshot sibling (effectiveness for streaks, trends for
  trajectories, corrections for the pattern-recurrence resumption).

### Changed

- `ComputeSurprisesInput` gains an optional `priorSurprises:
  SurprisesOutput | null` field. Callers that omit the field continue
  to receive V1 snapshot-only output — back-compat is preserved.
- `surprisesBuilder` orchestrates the archive lifecycle internally:
  read the most-recent-prior on entry, write today's snapshot to
  `archive/` after the primary file lands, prune archive entries
  older than `archiveRetentionDays`. The orchestrator
  (`packages/exporter/src/analysis/index.ts`) does not need to
  change.
- `surprisesBuilder` info log gains a `priorArchive=none|loaded`
  marker so operators can confirm whether the delta kinds had any
  prior to compare against.

### Notes

- **Race window:** archive write + prune are separate filesystem
  ops. A concurrent rescan racing the prune could lose at most one
  day of archive history (never today's freshly-written file —
  today is always within the retention window by definition).
  Read-side is tolerant: a partial / malformed archive returns null
  and the delta kinds skip cleanly.
- **Date stamps:** UTC YYYY-MM-DD via `Date#toISOString()`.
  Lexicographic sort = chronological sort under ISO-8601, so prune
  + "most recent" both work by filename without depending on mtime
  (which `git checkout` resets).
- **CLAUDE.md sidecar table** documents the new artifact under the
  outcome-substrate sidecars section as PII-bearing.

### Changed — daily brief reads as a journal, not a status panel (Wave 2 #4)

- The brief now opens with a single short paragraph that names the
  week's headline — shipped commits if any, otherwise the top STRONG
  positive surprise, otherwise a "quiet week" disclaimer — and each
  section's leader line is re-cast in narrative voice ("you shipped
  7 commits to main this week" not "► Shipped this week: 7
  commit(s) to main"). The Surprises section gains optional "The
  standout positive: …" and "Worth attention: …" framing sentences
  gated on STRONG-tier rows (score ≥ `SURPRISE_TIER_STRONG_MIN` =
  0.75). All count gates are preserved — zero-input sections still
  render nothing.
- `DailyBriefInputs` gains `topStrongPositiveSurprise?: string |
  null`; the `regen-brief.ts` shell extracts it from
  `analysis/surprises.json` by finding the first positive row whose
  score meets the STRONG floor. Kernel stays decoupled from the tier
  helper.
- Singular/plural now routes through a `pluralize(n, singular)`
  helper so the brief reads "1 commit", "1 claim", "1 pattern"
  without the `(s)` suffix pattern leaking into prose.
- 12 new tests in `dailyBrief.test.ts` (35 total, up from 23)
  covering opener paths (commits / strong-signal / quiet-week /
  shipped-wins-over-strong), STRONG-tier promotion gating,
  singular-form discipline, and audit-count truncation honesty.
- Shape-coherent with the 1.4.1 → 1.5.0 bump above; the brief
  markdown is shell-produced (not exporter-produced), so this change
  itself doesn't drive the version bump.

## [1.4.1] — 2026-05-24

Feed-redesign Phase γ polish — enriches the daily brief now that
Phase β promoted it to the top of the TODAY page. Patch bump (no new
on-disk artifact); the change is internal to the
`buildDailyBrief` kernel output + the `regen-brief` API endpoint.

### Changed

- `dailyBrief.ts` grows four new sections rendered between the
  existing "audit concerns" and "continuum health" blocks:
  - **Shipped this week** — commit count + top 5 subject lines from
    `git log --since="7 days ago" main`, computed by the
    `regen-brief.ts` shell and passed in as a precomputed input.
  - **Surprises today** — per-tone counts (positive / concerning)
    from `analysis/surprises.json` plus the top 3 positive summaries
    by score.
  - **Project trajectories** — per-classification counts from
    `analysis/project-trajectories.json` plus the top 3 most-active
    projects by `totalSessions`.
  - **Applied-pattern closures** — count of patterns currently held
    in the watcher's `holding` state. SDK accessor not yet wired;
    section skips cleanly (input is `null` in V1).
- Each section is independently skippable — empty inputs render
  nothing, matching the pre-existing convention.
- `DailyBriefResult.counts` gains seven fields covering the new
  sections (`shippedCommits`, `surprisesPositive`,
  `surprisesConcerning`, `trajectoriesAccelerating`,
  `trajectoriesFlat`, `trajectoriesStalling`,
  `appliedPatternClosures`). Existing fields unchanged.

### Notes

- The brief stays markdown + deterministic + LLM-free. The kernel
  remains a pure function; all I/O (sidecar reads + `git log`) lives
  in the `regen-brief.ts` API endpoint.
- `CLAUDE.md` "Outcome-substrate sidecars" section gains an
  **Intermediate sidecars** note documenting which artifacts are
  consumed internally by kernels / other sidecars rather than read
  by a UI surface (audit-claims.json, discovery-scores.json,
  duplicates.semantic.json, pr-land-cache.json). Pre-empts the
  "why doesn't X have a surface?" question for future contributors.

## [1.4.0] — 2026-05-24

Feed-redesign Phase A plumbing — adds a new `analysis/surprises.json`
sidecar produced by the pure `computeSurprises` kernel in
`@chat-arch/analysis`. Snapshot-based: reads the existing Phase 1-3
sidecars (composite-outcomes, project-trajectories, its-analysis,
reflexive, decisions, knowledge-debt) and emits a ranked list of
positive observations (`tone: 'positive'`) + concerns
(`tone: 'concerning'`) the user might not have noticed about their
recent work. No new kernel dependencies; no UI yet (Phase B lands the
"happy surprises and stories" surface that consumes this sidecar).

### Added

- **`analysis/surprises.json` sidecar.** Nine surprise kinds defined
  in the kernel API; **7 emit from the V1 builder pipeline**:
  `streak` / `trajectory-accelerating` / `config-helped` /
  `reflexive-positive` / `decision-paid-off` (positive) and
  `trajectory-stalled` / `debt-spinning` (concerns). The remaining
  two — `pattern-closed` and `pattern-recurring` — are defined and
  unit-tested but **dormant in V1**: the applied-pattern watcher
  ledger lives in the SQLite substrate and no
  `@chat-arch/exporter/db` SDK accessor exposes the verdicts to a
  Node consumer yet (see `TODO(applyWatcher-sdk):` marker in
  `packages/exporter/src/analysis/surprisesBuilder.ts`). When the
  accessor lands the builder swaps the empty list for the SDK call;
  no kernel change is required.
- Each row carries `{ id, kind, tone, summary (≤120 chars), evidence,
  score (0-1), generatedAt }`. File also exposes the threshold
  snapshot it used so the UI can disclaim.
- `computeSurprises` kernel (pure, browser-safe, deterministic given
  identical inputs) + `surprisesBuilder` Node shell that wires the
  sidecar reads + writes. Fail-soft: any missing input sidecar
  degrades the corresponding kinds to zero rows rather than aborting
  the build.
- All numeric knobs moved into `THRESHOLDS.surprises` (no inlined
  defaults). New thresholds: `reflexiveEValueMin` (1.5) gates
  `reflexive-positive` on E-value sensitivity in addition to CI
  positivity; `decisionGoodFollowupsMin` raised 2 → 5 in concert with
  a new Wilson-low > base-rate gate on `decision-paid-off`.
- `EXPORTER_VERSION` bumped 1.3.0 → 1.4.0 to mark the new artifact.

### Notes

- `reflexive-positive` summary copy is **associational, not causal**
  ("touching X is associated with +Npp" — not "lifted by Npp") to
  match the matched-pair primitive's actual inferential strength.
  The E-value floor + Wilson CI + practical-significance triple gate
  is the new minimum bar for emission.
- `decision-paid-off` is **same-project scoped**: followups outside
  the decision-session's project no longer count toward the K-followups
  floor or the Wilson lift gate. Decisions whose session has no
  discovered `projectId` are silently skipped by this branch (the
  decision still appears in `decisions.json`, just not as a paid-off
  surprise).

## [1.3.0] — 2026-05-24

Bumped from 1.2.0 to mark the Rev3 substrate landing. The on-disk
artifact set expands (analysis/curator-feed.json, analysis/
falsifier-verdicts.json, SQLite ledger in apps/standalone/chat-arch-
data/chat-arch.db). Pre-existing sidecars stay compatible — caches
for prior phases don't need to invalidate.

### Added

- **Phase Rev3-A — SQLite substrate.** `apps/standalone/chat-arch-
  data/chat-arch.db` (sibling of `public/` so it can't be served
  over HTTP). `better-sqlite3` + `sqlite-vec` deps; WAL mode +
  `synchronous=NORMAL` + `foreign_keys=ON` connection contract with
  `BEGIN IMMEDIATE` retry. 14-entity schema (projects / topics /
  sessions / messages / revisions / narratives / narrative_evidence /
  patterns / project_sessions / project_topics / topic_sessions /
  narrative_sessions / findings / analyzers) + `schema_migrations`
  runner. Wipe coverage in `/api/clear` extends to the SQLite
  sibling. THRESHOLDS gains `narrativeRung.*` / `curator.*` /
  `appliedRuleWatcher.*` blocks. PRs #53-#60 + tech-debt sweep
  PRs #61-#65.

- **Phase Rev3-B — Narrative provenance + confidence ladder.**
  `Narrative` schema gains `intent` / `observation` / `inference`
  / `attributedTo` / `verifiedAt` / `confidence` / `supportingCount`
  / `contradictingCount` / `correlatedOutcome` / `schemaVersion`
  fields; `NarrativeEvidence` gains optional `turnIndex`. Migration
  002 backfill kernel + `validateNarrative` accepts both shapes
  + `computeConfidence(supporting, contradicting, prior)` helper.
  Calibration fail-safe: kernels with `calibrationCompletedAt=null`
  get effective prior pinned to `narrativeRung.uncalibratedPrior`.
  PRs #66-#69.

- **Phase Rev3-C — Closure A (feedback ranking).** Renamed
  `knowledge-debt-state.ts` ledger to `entity-states.ts` (generic
  over Narrative + knowledge-debt items); JSON sidecar deprecated
  in favor of SQLite `entity_states` table (migration 003); legacy
  v1+v2 JSON folded on first open. `/api/entity-states` cutover.
  PRs #70+#71+#73+#74.

- **Phase Rev3-D — Closure B (decay / re-emergence).** Saturation
  rule (×2/×4/×8) capped at K=3, `narrativeSaturation` helper +
  `narrativePriorPenalty` re-promotion-penalty prior. NarrativeAudit
  row in `ProjectsMode` surfaces dismissal count + threshold;
  `showShelved` UI toggle. Family-wise α inflation caveat surfaced
  in `MethodologyDisclosure`. PRs #75-#78.

- **Phase Rev3-E — Closure C (applied-rule outcome) + Pattern
  falsifierStatus.** `Pattern.falsifierStatus: 'verified' |
  'skipped-by-user' | 'unavailable'`. Migration 004 adds
  `falsifier_status` column with CHECK constraint. Encode flow
  defaults to falsifier-gating; override checkbox writes
  `'skipped-by-user'`. `evaluateAppliedPatternWatcher` pure-decision
  kernel emits 4 verdict kinds (open/holding/recurring/inconclusive).
  PRs #79-#82.

- **Phase Rev3-F — Curator + falsifier skills.** `/curate` +
  `/falsify` skills under `.claude/skills/` driven via `claude -p`
  (default-deny `ANTHROPIC_API_KEY` fallback). `rankCuratorCandidates`
  ranker (tier-bucket-first sort, outcome-correlation as within-
  tier tie-breaker only). `aggregateFalsifierVerdicts` against
  `THRESHOLDS.curator.falsifierMinSupportRatio`. Meta-validation
  rolling 4-week n=40 verdicts + Wilson lower bound + drift banner.
  `CuratorFeed` component on PRACTICE surface. Subprocess infra:
  `probeClaudeAvailable` + `runCuratorSubprocess` with 1.5s probe
  + 50ms→1s exp backoff + env-scrub + per-spawn timeout + stderr
  redaction. PRs #83-#88.

- **Phase Rev3-G — Outcome-correlation rendering + significance
  gate.** Welch's t-test (`welchsTTest`) + non-parametric
  permutation back-stop (`permutationTestDelta`, xorshift32-seeded,
  p-value clamped to `[1/(K+1), 1]`). `evaluateCorrelationTagVisibility`
  tagged-union gate (visible / insufficient-evidence / below-
  significance / invalid-stat). Cross-tier invariant test pins
  "tie-break never promotes across tiers". G6 gate test composes
  G1 + G2 + F3/G4 + G5 in a swap-test pattern. `SourceAttribution`
  AttributionKind union extended with the new Rev3 rungs. PRs
  #89-#92.

- **Phase Rev3-H — MCP server scaffold.** New `@chat-arch/mcp-server`
  workspace package. `createMcpServer({workingDir})` factory.
  Security primitives:
  - `workingDir.ts` enforces basename `chat-arch-data` + absolute
    path + lexical-containment traversal guard with trailing-sep
    boundary check + Windows drive-letter case normalization +
    UNC reject.
  - `readOnly.ts` allow-listed read verb prefixes + deny-list
    with segment-scan against embedded write verbs.
  - `localhostBind.ts` policy gate — loopback IP literals only,
    no `localhost` hostname (rejected as defense-in-depth against
    hosts-file redirect).
  - `tools.ts` wires `@chat-arch/exporter/db` SDK as 10 MCP tools
    (`get_<entity>` + `list_<entity>` for projects / topics /
    narratives / patterns / findings) with full SDK-filter parity
    (including `session: SessionKey | null` + null anchor IDs).
  - `tools.gate.test.ts` H5 equivalence gate — `tool.handler(args)`
    deep-equals direct SDK call across every filter key via
    `satisfies (keyof Filter)[]` exhaustiveness check.
  - Closed-flag + deep-freeze of registered tools.
  Protocol layer (stdio transport + `@modelcontextprotocol/sdk`
  wiring) deferred to a separate protocol PR — tracked as H6 in
  `_planning/chat-arch-v2-rev3-progress.md` + `_planning/chat-arch-
  v2-rev3-plan.md` §Deferred work. Until that protocol PR lands,
  the plan's exit phrase ("the same query returns equivalent results
  in the viewer and from an external claude session") is verified
  in-process only — the gate test pins SDK ≡ tool.handler
  equivalence, not the end-to-end protocol round-trip. PRs #93+#94.

- **Phase Rev3-I — Documentation hygiene (this release).**
  CLAUDE.md "Data on disk" expanded with the SQLite entity-table
  PII inventory + Narrative schemaVersion 2 prose-field expansion
  + Rev3-F curator-feed + falsifier-verdicts sidecar entries.
  README gains "Hosted vs local — deliberately scoped divergence"
  capability table. `.githooks/pre-commit` extended to block any
  `*.db`/`*.db-wal`/`*.db-shm` staging + any staged file under
  `apps/standalone/public/chat-arch-data/` (beyond the empty
  baseline manifest) + any staged file under `apps/standalone/
  chat-arch-data/`. `.gitignore` documents the Rev3-F sidecars
  explicitly. EXPORTER_VERSION bumped to 1.3.0.

#### Additional per-PR detail (pre-amalgamated Unreleased entries that landed in 1.3.0)

- **Phase Rev3-E complete (E6 Closure-C gate test).** Integration
  test at `apps/standalone/test/integration/closure-c-applied-pattern-gate.test.ts`
  composes the full Closure-C round-trip:
  - **Encode flow (E3):** asserts `buildPatternFromNarrative` omits
    `falsifierStatus` on the default path (Rev3-F will populate it
    later) and writes `'skipped-by-user'` when the override checkbox
    fires; `appendedToClaudeMd` flag is preserved independently.
  - **Watcher kernel (E4+E5):** walks `evaluateAppliedPatternWatcher`
    through all three closure paths: open → holding (N sessions
    without recurrence), open → recurring (negative narrative fires
    after encoding; verdict carries the offending narrative id +
    timestamp for curator formatting), open → inconclusive on
    wall-clock timeout.
  - **Audit trail:** two encoded patterns (one default, one bypass)
    are distinguishable downstream by `falsifierStatus ===
    'skipped-by-user'` — pinning the plan's "bypass path produces an
    auditable Pattern row" gate.

  7 test cases; all pass. **Closes Phase Rev3-E** — Closure C
  (applied-rule outcome) is now wired end-to-end through the SQLite
  substrate from C4 and the watcher kernel from E4+E5. The pure-
  decision kernel + the encode-time falsifierStatus sentinel give
  Rev3-F's curator everything it needs to surface RECURRING_AFTER_-
  APPLIED and WATCH_INCONCLUSIVE Narratives at the right moments.

- **Per-narrative audit affordance (Phase Rev3-D D3).** New
  `NarrativeAudit` subcomponent in
  `packages/viewer/src/components/modes/ProjectsMode.tsx` renders an
  audit row inside every Narrative card showing:
  - `N / cap` dismissal count from `entity_states.dismissal_count`.
  - The effective re-promotion threshold ("re-emerges at ≥X
    evidence (now: Y)") for DISMISSED entries, computed via the
    D1-era `narrativeSaturation` helper.
  - A `SHELVED` sentinel for cap-reached entries (D4 will add the
    "show shelved" toggle to filter the cards from the active list).
  - A DISMISS button that posts to `/api/entity-states` and bumps
    the local-state counter optimistically (server-side counter is
    canonical; the client mirrors per-transition).

  Wired via a new `dataDirBaseUrl` prop on `ProjectsMode` →
  `ProjectDetail`, defaulting to the standalone data root. The
  detail surface loads the entity-states ledger once on mount and
  passes each card its per-narrative audit slice.

  Tests in `packages/viewer/src/components/modes/ProjectsMode.test.tsx`:
  default counts when no ledger entry exists, DISMISSED rendering
  with threshold display, SHELVED sentinel for at-cap, plus
  click-DISMISS-then-assert-fetch + the standard a11y label shape.

  Closure-B saturation is now visible in the UI — the user can see
  exactly how close a narrative is to permanent shelving and what
  evidence growth would re-emerge it. D4 + D5 complete the phase.

- **Phase Rev3-C complete (C5 round-trip gate test).** New integration
  test `apps/standalone/test/integration/narrative-entity-state-round-trip.test.ts`
  exercises the full ledger pipeline on a narrative: validate POST body
  → SDK upsert → state transition → growth-multiplier re-promotion
  rule → re-dismiss → SDK list. Verifies the Closure-A gate stated in
  the plan: "a surfaced Narrative can be dismissed and re-promoted via
  the existing growth-multiplier mechanism." Three test cases:
  - Full round-trip (PENDING → DISMISSED counter=1 → growth multiplier
    re-promotes → PENDING preserves counter=1 → DISMISSED counter=2).
  - Composite-key independence across two narratives (no bleed).
  - Equivalent round-trip on a `knowledge-debt` entity (proves the
    C1+C2 generalization didn't introduce a kind-specific path).

  Closes Phase Rev3-C. Closure A (feedback ranking) is now wired
  end-to-end through the SQLite substrate. Closure B (decay /
  re-emergence) ships in Phase Rev3-D — the `dismissalCount`
  counter the round-trip exercises is the foundation D1 reads to
  drive the saturation rule (×2/×4/×8 cap K).

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
