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
| B1 | Extend `packages/schema/src/narrative.ts` with provenance fields (intent, observation, inference, attributedTo, verifiedAt, confidence, supportingCount, contradictingCount, correlatedOutcome, schemaVersion) | pending | |
| B2 | Extend `NarrativeEvidence` with optional `turnIndex` | pending | |
| B3 | DB migration adding the new columns to the `narratives` table | pending | |
| B4 | `validateNarrative()` accepts both schemaVersion 1 and 2 | pending | |
| B5 | Backfill kernel — one-shot run over any existing narratives (post zero-data start, normally empty) computing confidence + setting `attributedTo='deterministic'` + bumping to schemaVersion 2 | pending | |
| B6 | Confidence-ladder helper (`computeConfidence(supporting, contradicting, prior)`) consuming THRESHOLDS | pending | |
| B7 | Calibration fail-safe: kernels with `calibrationCompletedAt = null` get effective prior pinned to `narrativeRung.uncalibratedPrior`; banner surfaces "kernel X uncalibrated" | pending | |
| B8 | Named test `narrative.migration.test.ts` — covers legacy parse, deterministic backfill, round-trip, dual-schema acceptance | pending | Gate |
| B9 | PII handling for narrative previews — default-blur with reveal-on-click before any curator surface ships | pending | Gate |

**Gates:** named `narrative.migration.test.ts` passes; existing `validateNarrative()` accepts both schemaVersion shapes.

---

## Phase Rev3-C — Closure A wiring (feedback ranking)

Plan anchor: [§Phase Rev3-C](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| C1 | Rename `knowledge-debt-state.ts` ledger to `entity-states.ts` (generalize over narrative + knowledge-debt items) | pending | |
| C2 | Migrate state shape — handle Narrative IDs + knowledge-debt IDs under one entry shape; preserve back-compat read | pending | |
| C3 | Add `narrative` kind to `insights-ack.ts` KNOWN_KINDS allow-list for binary-ack case | pending | |
| C4 | Wire the new entity-states ledger to read/write through the SQLite SDK (not a separate JSON file going forward) | pending | |
| C5 | Tests: dismiss-then-evidence-grows-then-re-promote round-trip on a Narrative | pending | Gate |

**Gates:** a surfaced Narrative can be dismissed and re-promoted via the existing growth-multiplier mechanism.

---

## Phase Rev3-D — Closure B wiring (decay / re-emergence)

Plan anchor: [§Phase Rev3-D](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| D1 | Saturation rule (×2/×4/×8) implemented in entity-states ledger; cap K=3 (THRESHOLDS-resident) | pending | |
| D2 | Per-Narrative re-promotion-penalty prior += `narrativeRung.repromotionPenalty` on each dismissal | pending | |
| D3 | Audit-table view in the viewer surfacing dismissal count per item | pending | |
| D4 | Shelved-permanently affordance + explicit "show shelved" UI toggle | pending | |
| D5 | Tests: cap-K behavior + family-wise α inflation documented in methodology disclosure | pending | Gate |

**Gates:** a previously-dismissed Narrative re-enters the feed only after evidence growth exceeds the multiplier; capped re-promotion attempts visible in the audit table.

---

## Phase Rev3-E — Closure C wiring (applied-rule outcome) + Pattern.falsifierStatus

Plan anchor: [§Phase Rev3-E](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| E1 | Pattern entity schema gains `falsifierStatus: 'verified' \| 'skipped-by-user' \| 'unavailable'` | pending | |
| E2 | DB migration adding `falsifier_status` column to `patterns` table | pending | |
| E3 | Encode-as-pattern flow defaults to falsifier-gating; explicit override checkbox writes `skipped-by-user` | pending | |
| E4 | Next-sessions watcher: triggers `RECURRING_AFTER_APPLIED` or `WATCH_INCONCLUSIVE` on N=5 / 60d / project-inactivity 30d | pending | |
| E5 | Wall-clock timeout emits low-priority `WATCH_INCONCLUSIVE` Narrative (not silence) | pending | |
| E6 | Tests: applied pattern visibly closes its watcher within the window; bypass path produces auditable Pattern row | pending | Gate |

**Gates:** an applied pattern visibly closes its watcher within the window; bypass path produces an auditable Pattern row.

---

## Phase Rev3-F — Curator + falsifier agents

Plan anchor: [§Phase Rev3-F](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| F1 | `/curate` skill scaffolded under `.claude/skills/` driven by `claude -p` via `resolveClaude.ts` | pending | |
| F2 | Falsifier skill — structurally separate, different system prompt, different prompt template | pending | |
| F3 | Curator ranks tier-2 + tier-3 Narratives, outcome-correlation as tie-breaker only | pending | |
| F4 | Falsifier verifies each finding's `evidenceChain` cites real session turns whose content supports the claim | pending | |
| F5 | Subprocess fallback: `claude --version` probe at startup; 429 backoff + retry once; banner on persistent failure | pending | |
| F6 | API-key fallback OFF by default; `chatArchCuratorApiKeyOptIn` localStorage toggle in local viewer only | pending | |
| F7 | Atomic tmp-file + rename writes for generator + falsifier output | pending | |
| F8 | Meta-validation: rolling 4-week n=40 verdicts; Wilson lower bound against `curator.falsifierAccuracyFloor`; banner on drift | pending | |
| F9 | Curator feed surfaces as top section on PRACTICE (above the four lenses), NOT a new top-level surface | pending | |
| F10 | Tests: falsifier rejection rate inside bracket; meta-accuracy stable on fixture corpus | pending | Gate |

**Gates:** falsifier rejection rate inside bracket; meta-accuracy stable; user engages with ≥1 surfaced item per week.

---

## Phase Rev3-G — Outcome-correlation rendering + significance-gated ranker

Plan anchor: [§Phase Rev3-G](chat-arch-v2-rev3-plan.md#phased-delivery-post-§0-amendments).

| # | Sub-task | Status | PR / notes |
|---|---|---|---|
| G1 | Welch's t-test (or non-parametric permutation) implementation in `packages/analysis/src/` | pending | |
| G2 | Outcome-correlation tag visibility gated on `\|Δ\|/SE` exceeding `curator.outcomeCorrelationSignificance` AND `evidence.length ≥ 5` | pending | |
| G3 | Extend `SourceAttribution.tsx` `AttributionKind` union with new rungs (`'tier1' \| 'tier2' \| 'tier3' \| 'falsifier-verified' \| 'llm-derived' \| 'deterministic-with-prior' \| 'correlation-significant'`) | pending | Single component; no parallel MethodHint |
| G4 | Curator ranker uses correlation only as tie-breaker within a tier (does NOT promote across tiers) | pending | |
| G5 | Falsifier runs permutation test resampling project sessions to confirm Δ unlikely under H0 | pending | |
| G6 | Tests: correlation tags visible only when |Δ|/SE exceeds threshold; tie-breaker only fires on evidence ≥ 5 | pending | Gate |

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
