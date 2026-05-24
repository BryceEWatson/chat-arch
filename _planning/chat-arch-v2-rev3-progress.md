# chat-arch v2 Rev 3 — Progress Tracker

**Authoritative plan:** [_planning/chat-arch-v2-rev3-plan.md](chat-arch-v2-rev3-plan.md)
**Locked spec (amended):** [_planning/chat-arch-v2-spec.md](chat-arch-v2-spec.md)
**Initialized:** 2026-05-22 (session 1).

Status legend: `pending` / `in-progress` / `in-review` (PR open) / `complete-and-merged` / `blocked` / `dropped`.

## Exit criteria (all four must hold)

1. Every sub-task below marked `complete-and-merged` across all 9 phases.
2. The spec-amendment commit for §13 + §16 lands on main.
3. `pnpm test` shows at least one test per new kernel / API endpoint / SDK method / migration step.
4. Final-pass `/review-loop` over `git diff rev3-start..main` exits review-clean.

---

## Phase Rev3-A — SQLite substrate + locked-spec amendment commit

Plan anchor: [§Phase Rev3-A](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| A0 | Set `rev3-start` git tag on `origin/main` before any Rev3 branches | complete-and-merged | Out-of-band setup (tag exists on origin at `5c480aa`) |
| A1 | Amend `chat-arch-v2-spec.md` §13 (SQLite substrate) and §16 (curator/falsifier/MCP in scope) | complete-and-merged | PR #54 (+ PR #56 extended §5 to 7-surface IA per Rev3 D1) |
| A2 | Add `*.db / *.db-wal / *.db-shm` to `.gitignore` | complete-and-merged | PR #55 |
| A3 | Add `better-sqlite3` + `sqlite-vec` deps; CI spike confirming prebuilt binaries on Ubuntu runner | complete-and-merged | PR #55 |
| A4 | Create `packages/exporter/src/db/migrations/` with migration framework (`schema_migrations` table, idempotent migration runner) — moved from `packages/schema/` since `better-sqlite3` is a Node native module and `packages/schema/` must stay browser-safe | complete-and-merged | PR #57 |
| A5 | Initial migration: tables for `projects`, `topics`, `sessions`, `session_messages`, `session_revisions`, `narratives`, `narrative_evidence`, `narrative_sessions`, `patterns`, `project_sessions`, `project_topics`, `topic_sessions`, `findings`, `analyzers` (13 entity + 1 generic findings) | complete-and-merged | PR #57 |
| A6 | Enable WAL mode + `synchronous=NORMAL` + `foreign_keys=ON`; document `BEGIN IMMEDIATE` single-writer contract with 50ms→1s exponential backoff retry | complete-and-merged | PR #57 |
| A7 | THRESHOLDS additions in `packages/analysis/src/thresholds.ts`: `narrativeRung.*`, `curator.*`, `appliedRuleWatcher.*` | complete-and-merged | PR #58 |
| A8 | SDK skeleton in `packages/exporter/src/db/` exposing typed query/write methods over the new tables | complete-and-merged | PR #59 |
| A9 | Extend `NuclearReset` to sweep orphan JSON files under `chat-arch-data/analysis/` | complete-and-merged | PR #53 (outcome-substrate roadmap shipped the NuclearReset extension as Phase 4 work) |
| A10 | "NO DATA YET" landing screen renders correctly against empty DB | complete-and-merged | Verified in PR #59 — no SQLite imports in `apps/standalone/src/`; 159 standalone tests + 15 empty-state contract tests pass against post-A6 main; the SQLite substrate is exporter-only infrastructure not yet wired into page rendering. |
| A11 | Seeded-fixture test corpus → SDK returns expected rows | in-review | PR #TBD |

**Gates:** SDK returns expected rows from a seeded-fixture test corpus; empty-database initial state renders the "NO DATA YET" landing screen correctly; native-module CI spike passes.

---

## Phase Rev3-B — Narrative provenance + confidence ladder

Plan anchor: [§Phase Rev3-B](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| B1 | Extend `packages/schema/src/narrative.ts` with provenance fields (intent, observation, inference, attributedTo, verifiedAt, confidence, supportingCount, contradictingCount, correlatedOutcome, schemaVersion) | in-review | PR #TBD |
| B2 | Extend `NarrativeEvidence` with optional `turnIndex` | in-review | PR #TBD |
| B3 | DB migration adding the new columns to the `narratives` table | in-review | PR #TBD (migration `002-narrative-provenance.ts`) |
| B4 | `validateNarrative()` accepts both schemaVersion 1 and 2 | in-review | PR #TBD |
| B5 | Backfill kernel — one-shot run over any existing narratives (post zero-data start, normally empty) computing confidence + setting `attributedTo='deterministic'` + bumping to schemaVersion 2 | in-review | PR #TBD (module `backfillNarrativeProvenance.ts`) |
| B6 | Confidence-ladder helper (`computeConfidence(supporting, contradicting, prior)`) consuming THRESHOLDS | in-review | PR #TBD |
| B7 | Calibration fail-safe: kernels with `calibrationCompletedAt = null` get effective prior pinned to `narrativeRung.uncalibratedPrior`; banner surfaces "kernel X uncalibrated" | in-review | PR #TBD (helper landed; viewer banner wires in with B5 backfill caller) |
| B8 | Named test `narrative.migration.test.ts` — covers legacy parse, deterministic backfill, round-trip, dual-schema acceptance | in-review | PR #TBD (covers dual-schema acceptance + structural rejections; backfill-round-trip lands with B5) |
| B9 | PII handling for narrative previews — default-blur with reveal-on-click before any curator surface ships | in-review | PR #TBD (BlurredPii component + wired into ProjectsMode narrative title/body; evidence pill `title` attribute leak fixed) |

**Gates:** named `narrative.migration.test.ts` passes; existing `validateNarrative()` accepts both schemaVersion shapes.

---

## Phase Rev3-C — Closure A wiring (feedback ranking)

Plan anchor: [§Phase Rev3-C](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| C1 | Rename `knowledge-debt-state.ts` ledger to `entity-states.ts` (generalize over narrative + knowledge-debt items) | complete-and-merged | PR #70 |
| C2 | Migrate state shape — handle Narrative IDs + knowledge-debt IDs under one entry shape; preserve back-compat read | complete-and-merged | PR #70 (server reads legacy `knowledge-debt-states.json` when v2 file absent; viewer client mirrors the fallback) |
| C3 | Add `narrative` kind to `insights-ack.ts` KNOWN_KINDS allow-list for binary-ack case | complete-and-merged | PR #71 |
| C4 | Wire the new entity-states ledger to read/write through the SQLite SDK (not a separate JSON file going forward) | complete-and-merged | PR #73 (migration 003 + entityStates SDK module + standalone DB connection helper with legacy v1+v2 JSON fold + endpoint cutover + viewer client API-first read with JSON-sidecar fallback; iter-1 fix moved DB out of `public/` after security review) |
| C5 | Tests: dismiss-then-evidence-grows-then-re-promote round-trip on a Narrative | complete-and-merged | PR #74 (closes Phase Rev3-C — SDK-layer round-trip + standalone-layer integration test) |

**Gates:** a surfaced Narrative can be dismissed and re-promoted via the existing growth-multiplier mechanism.

---

## Phase Rev3-D — Closure B wiring (decay / re-emergence)

Plan anchor: [§Phase Rev3-D](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| D1 | Saturation rule (×2/×4/×8) implemented in entity-states ledger; cap K=3 (THRESHOLDS-resident) | complete-and-merged | PR #75 (`narrativeSaturation` helper in `packages/analysis/src/narrativeRung.ts`; consumes `THRESHOLDS.narrativeRung.dismissDecay` + `maxDismissals` + `actionBanner.knowledgeDebtRepromotionGrowthMultiplier`) |
| D2 | Per-Narrative re-promotion-penalty prior += `narrativeRung.repromotionPenalty` on each dismissal | complete-and-merged | PR #76 (`narrativePriorPenalty` helper in `packages/analysis/src/narrativeRung.ts` — composes additively with `effectivePriorForKernel`) |
| D3 | Audit-table view in the viewer surfacing dismissal count per item | complete-and-merged | PR #77 (`NarrativeAudit` row in `packages/viewer/src/components/modes/ProjectsMode.tsx` — surfaces dismissal count + re-promotion threshold; DISMISS button posts to `/api/entity-states`; iter-1 fix column-flex footer + prefer-server-`entry` mirrored in InsightsMode) |
| D4 | Shelved-permanently affordance + explicit "show shelved" UI toggle | in-review | PR #TBD (transient `showShelved` state + checkbox in `ProjectDetail`'s narratives header; partitions narratives via `narrativeSaturation`; safe default = OFF) |
| D5 | Tests: cap-K behavior + family-wise α inflation documented in methodology disclosure | in-review | PR #TBD (gate test walks `dismissalCount` from cap−1 → cap and asserts shelved transition; `MethodologyDisclosure` gains family-wise correction caveat) |

**Gates:** a previously-dismissed Narrative re-enters the feed only after evidence growth exceeds the multiplier; capped re-promotion attempts visible in the audit table.

---

## Phase Rev3-E — Closure C wiring (applied-rule outcome) + Pattern.falsifierStatus

Plan anchor: [§Phase Rev3-E](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| E1 | Pattern entity schema gains `falsifierStatus: 'verified' \| 'skipped-by-user' \| 'unavailable'` | complete-and-merged | PR #79 (`Pattern.falsifierStatus` + `PatternFalsifierStatus` union + `PATTERN_FALSIFIER_STATUS_VALUES` exports in `packages/schema/src/pattern.ts`; optional for back-compat with pre-Rev3-E patterns) |
| E2 | DB migration adding `falsifier_status` column to `patterns` table | complete-and-merged | PR #79 (migration 004 — `falsifier_status TEXT` with CHECK constraint over the three terminal states; NULL allowed for back-compat) |
| E3 | Encode-as-pattern flow defaults to falsifier-gating; explicit override checkbox writes `skipped-by-user` | complete-and-merged | PR #80 (`buildPatternFromNarrative` accepts `falsifierOverride`; `NarrativeCard` adds positive-only checkbox + status-message variant when override fires; default OFF so the safe path remains "let Rev3-F falsifier verify later") |
| E4 | Next-sessions watcher: triggers `RECURRING_AFTER_APPLIED` or `WATCH_INCONCLUSIVE` on N=5 / 60d / project-inactivity 30d | in-review | PR #TBD (`evaluateAppliedPatternWatcher` pure-decision kernel in `packages/analysis/src/applyWatcher.ts`; emits `{kind:'open'\|'holding'\|'recurring'\|'inconclusive'}` verdicts. Orchestration lands with Rev3-F curator) |
| E5 | Wall-clock timeout emits low-priority `WATCH_INCONCLUSIVE` Narrative (not silence) | in-review | PR #TBD (same kernel returns `{kind:'inconclusive', reason:'wall-clock-timeout'\|'project-inactive'}`; curator formats the Narrative at low feed priority) |
| E6 | Tests: applied pattern visibly closes its watcher within the window; bypass path produces auditable Pattern row | in-review | PR #TBD (closes Phase Rev3-E — integration test in `apps/standalone/test/integration/closure-c-applied-pattern-gate.test.ts` composes E3 encode → E4+E5 watcher kernel across all three closure paths: holding, recurring, inconclusive) |

**Gates:** an applied pattern visibly closes its watcher within the window; bypass path produces an auditable Pattern row.

---

## Phase Rev3-F — Curator + falsifier agents

Plan anchor: [§Phase Rev3-F](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| F1 | `/curate` skill scaffolded under `.claude/skills/` driven by `claude -p` via `resolveClaude.ts` | in-review | PR #TBD (SKILL.md at `.claude/skills/curate/` — frontmatter + 4-stage pipeline scaffold referencing F3 ranker kernel + F4 falsifier hand-off + F8 meta-validation + F9 PRACTICE surface) |
| F2 | Falsifier skill — structurally separate, different system prompt, different prompt template | in-review | PR #TBD (SKILL.md at `.claude/skills/falsify/` — separate agent type, neutral auditor framing; per-finding verdict pipeline with self-consistency K=3 + atomic verdict write; never re-ranks or composes with generator) |
| F3 | Curator ranks tier-2 + tier-3 Narratives, outcome-correlation as tie-breaker only | in-review | PR #TBD (`rankCuratorCandidates` pure-decision kernel in `packages/analysis/src/curatorRanker.ts`; tier-bucket-first sort prevents cross-tier promotion via correlation; correlation honored only as within-tier tie-breaker per plan §G2) |
| F4 | Falsifier verifies each finding's `evidenceChain` cites real session turns whose content supports the claim | in-review | PR #TBD (`aggregateFalsifierVerdicts` aggregator in `packages/analysis/src/falsifierVerifier.ts`; per-turn LLM verdicts in `/falsify` skill, aggregated here against `THRESHOLDS.curator.falsifierMinSupportRatio` = 0.6; unavailable counts as failure for citation hygiene) |
| F5 | Subprocess fallback: `claude --version` probe at startup; 429 backoff + retry once; banner on persistent failure | in-review | PR #TBD (`probeClaudeAvailable` + `runCuratorSubprocess` in `apps/standalone/src/lib/curatorClaude.ts`; 1.5s probe timeout; 50ms→1s exp backoff with `maxElapsedMs=30s`; tagged-union `RunCuratorResult` for banner dispatch) |
| F6 | API-key fallback OFF by default; `chatArchCuratorApiKeyOptIn` localStorage toggle in local viewer only | in-review | PR #TBD (two-rail default-deny: viewer `curatorApiKeyOptIn.ts` + server `apiKeyFallbackAllowedFromEnv` env-flag; both must be ON for the env var to reach the subprocess; otherwise `ANTHROPIC_API_KEY` is scrubbed before spawn) |
| F7 | Atomic tmp-file + rename writes for generator + falsifier output | complete-and-merged | Existing `packages/exporter/src/lib/atomicWrite.ts` (`atomicWriteJson` / `atomicWriteJsonSync`) — landed in PR #53 outcome-substrate; F1+F2 skill prompts reference it directly. No new code needed; verified the contract matches the curator/falsifier output write needs. |
| F8 | Meta-validation: rolling 4-week n=40 verdicts; Wilson lower bound against `curator.falsifierAccuracyFloor`; banner on drift | in-review | PR #TBD (`evaluateFalsifierMetaAccuracy` pure-decision kernel in `packages/analysis/src/falsifierMetaAccuracy.ts`; sample-size guard (n ≥ 40) prevents small-n false-alarm noise; Wilson LB via existing `wilsonCI` helper; emits `{inDrift, n, accuracy, lowerBound, floor, minN}` for the curator banner) |
| F9 | Curator feed surfaces as top section on PRACTICE (above the four lenses), NOT a new top-level surface | in-review | PR #TBD (`CuratorFeed` component + `curatorFeedClient.loadCuratorFeed`; renders ranked items with kind chip + composite score + falsifier-status tag + F8 drift banner; graceful empty state when `analysis/curator-feed.json` is absent — /curate skill hasn't run yet) |
| F10 | Tests: falsifier rejection rate inside bracket; meta-accuracy stable on fixture corpus | in-review | PR #TBD (`curatorPipeline.gate.test.ts` composes F3 ranker + F4 verifier + F8 meta-validation on synthetic fixtures; pins rejection rate at 0.35 inside `[0.2, 0.5]` bracket, meta-accuracy stable in high-accuracy regime (n=40@95% LB clears floor; n=100@90% likewise), drift correctly fires at 60% accuracy. User-engagement clause from plan is environmental, not testable in CI. Closes Phase Rev3-F.) |

**Gates:** falsifier rejection rate inside bracket; meta-accuracy stable; user engages with ≥1 surfaced item per week.

---

## Phase Rev3-G — Outcome-correlation rendering + significance-gated ranker

Plan anchor: [§Phase Rev3-G](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| G1 | Welch's t-test (or non-parametric permutation) implementation in `packages/analysis/src/` | in-review | PR #TBD (`welchsTTest` in `packages/analysis/src/welchsTTest.ts` — pure function returning `{t, delta, standardError, degreesOfFreedom, pValueTwoSided, valid}`; defensive on degenerate inputs; normal-CDF p-value approximation reuses existing `normalCdf` helper) |
| G2 | Outcome-correlation tag visibility gated on `\|Δ\|/SE` exceeding `curator.outcomeCorrelationSignificance` AND `evidence.length ≥ 5` | in-review | PR #TBD (`evaluateCorrelationTagVisibility` in `packages/analysis/src/correlationTagGate.ts` — tagged-union verdict (`visible \| 'insufficient-evidence' \| 'below-significance' \| 'invalid-stat'`) so renderers can show distinct copy per non-shown reason) |
| G3 | Extend `SourceAttribution.tsx` `AttributionKind` union with new rungs (`'tier1' \| 'tier2' \| 'tier3' \| 'falsifier-verified' \| 'llm-derived' \| 'deterministic-with-prior' \| 'correlation-significant'`) | in-review | PR #TBD (7 new rungs added; `REV3_ATTRIBUTION_KINDS` const exports the subset; existing 9 tests preserved + 3 new tests pin the new rungs render + aria + REV3 constant) |
| G4 | Curator ranker uses correlation only as tie-breaker within a tier (does NOT promote across tiers) | complete-and-merged | PR #91 (`curatorRanker.crossTierInvariant.test.ts` — discoverable named test pinning three failure modes: correlation folded into composite, tier-vs-composite sort order, cross-tier tie-break. The invariant itself was already implemented + tested in F3/PR #85; G4 is the discoverable cross-ref.) |
| G5 | Falsifier runs permutation test resampling project sessions to confirm Δ unlikely under H0 | complete-and-merged | PR #91 (`permutationTestDelta` in `packages/analysis/src/correlationPermutation.ts` — pure, deterministic xorshift32-seeded permutation kernel; two-sided empirical p-value clamped to `[1/(K+1), 1]`; defensive contract handles empty/NaN/constant-pool. 16 tests cover correctness + bounds + determinism + Welch-vs-permutation consistency.) |
| G6 | Tests: correlation tags visible only when |Δ|/SE exceeds threshold; tie-breaker only fires on evidence ≥ 5 | in-review | PR #TBD (`correlationGate.gate.test.ts` — integration gate composing G1 Welch + G2 visibility + F3/G4 ranker + G5 permutation back-stop. Pins both invariants via swap-test: with G2 hiding the tag (evidence < 5 OR \|t\| below significance), correlation cannot influence rank order; with G2 passing, correlation tie-break decides. 12 tests across visibility / tie-breaker / permutation-Welch agreement. Closes Phase Rev3-G.) |

**Gates:** correlation tags visible only when |Δ|/SE exceeds threshold; tie-breaker only fires on evidence ≥ 5.

---

## Phase Rev3-H — MCP server

Plan anchor: [§Phase Rev3-H](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| H1 | Standalone MCP server package under `packages/mcp-server/` | pending | |
| H2 | Read-only by default; narrow tool surface (no arbitrary `readFile`, no `claude -p` exec from server, working-dir scoped to `chat-arch-data/`) | pending | |
| H3 | Expose data SDK query methods as MCP tools (projects, topics, narratives, patterns, findings) | pending | |
| H4 | Localhost-bind only in v2.0; remote MCP-over-HTTP explicit non-goal (descoped to later amendment) | pending | |
| H5 | Tests: same query returns equivalent results in the viewer and from an external claude session | pending | Gate |

**Gates:** the same query returns equivalent results in the viewer and from an external claude session.

---

## Phase Rev3-I — Documentation hygiene + CLAUDE.md updates

Plan anchor: [§Phase Rev3-I](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| I1 | Update project `CLAUDE.md` "Data on disk" section: new SQLite DB file + renamed entity-states ledger + Narrative schemaVersion 2 PII expansion | pending | |
| I2 | Update README to formalize hosted-viewer divergence (chat-arch.dev stays JSON-sidecar-only as deliberately-scoped demo of the local pipeline) | pending | |
| I3 | Extend `.githooks/pre-commit` to scan any new sidecar with user-content (Narratives carry quoted excerpts → PII) | pending | |
| I4 | Confirm `.gitignore` covers SQLite DB family + any new sidecars | pending | |
| I5 | Bump `EXPORTER_VERSION` to reflect the SQLite cutover; add CHANGELOG entry | pending | |
| I6 | Manual hygiene check: fresh contributor can read CLAUDE.md and correctly enumerate what's on disk and what carries PII | pending | Gate |

**Gates:** fresh contributor can read CLAUDE.md and correctly enumerate what's on disk and what carries PII.

---

## Session log

### Session 1 — 2026-05-22

- Initialized this tracker by enumerating sub-tasks per phase from [chat-arch-v2-rev3-plan.md](chat-arch-v2-rev3-plan.md).
- Pre-existing open PRs at session start (not opened by this loop): #46, #48, #52, #53.
- Pre-existing uncommitted local changes on `feature/outcome-substrate-roadmap` at session start (not touched by this loop): `manifest.json` + four source files under `apps/standalone/src/`.
- Chunk this session: sub-task **A1** (spec amendment §13 + §16) + tracker creation, landed together. Sub-task **A0** (`rev3-start` tag) handled out-of-band before branching.

### Session 2 — 2026-05-22 (later same day)

- PR #54 (A1 spec amendment + tracker) merged.
- Chunk this session: sub-tasks **A2** + **A3** (gitignore patterns for `*.db*` + `better-sqlite3` + `sqlite-vec` deps + native-module CI spike test). Landed as PR #55.
- Codex bot review surfaced a real defect: the WAL pragma test ran against `:memory:`, which silently ignores `journal_mode = WAL`. Fixed in commit `9e2f16e` to use a file-backed temp DB.

### Session 3 — 2026-05-23

- Multi-agent adversarial review of PR #53 dispatched (5 reviewers + execution runner). Falsifier upheld 24 of 25 LOAD-BEARING findings (R2 falsified). User worked review fixes manually; mid-flight strategic-planning prompt requested + drafted.
- PR #55 (A2 + A3) merged. PR #56 (Bryce's IA amendment for review finding D1) also merged.
- Chunk this session: sub-tasks **A4** (migration framework — moved from `packages/schema/src/db/` to `packages/exporter/src/db/migrations/` since `better-sqlite3` is a Node native module) + **A5** (initial schema migration creating 12 tables: 4 entities + 1 sessions + 1 messages + 1 revisions + 1 evidence + 3 junctions + 1 findings + 1 analyzers, plus 8 indexes) + **A6** (WAL/synchronous=NORMAL/foreign_keys=ON connection helper + `BEGIN IMMEDIATE` retry wrapper with 50ms→1s exponential backoff per plan §"SQLite write contract"). 22 new tests covering connection contract, transaction commit/rollback/retry/budget-exhaustion, runner idempotency + rollback-on-failure, and per-table FK + CASCADE + SET NULL behavior.
