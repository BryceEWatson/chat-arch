# chat-arch v2 Rev 3 — Additive Proposals on Locked Spec

> **Status:** Iter-1 rewrite (May 22, 2026) after /review-loop iter-0
> surfaced load-bearing conflicts between Rev 3 (as originally drafted)
> and `chat-arch-v2-spec.md` (locked April 2026).
>
> **What changed iter-0 → iter-1:** original Rev 3 proposed SQLite +
> sqlite-vec substrate, a flat `findings` schema, MCP server, and a
> phased delivery that ignored the four-surface IA. All four conflicted
> with the locked spec. Iter-1 reframes Rev 3 as **additive proposals on
> top of the locked spec** — keeping the curator-first inversion, the
> confidence ladder, the three loop closures, and the generator/falsifier
> discipline, but mapping them onto the existing entity model and
> persistence shape. Substrate-replacement claims are moved to §0
> (lock-break decision required) or dropped.

## §0 — Spec amendments (approved May 22, 2026)

Iter-0 reviewers correctly identified that Rev 3 conflicted with the locked v2 spec on four dimensions. User decided each:

| Locked-spec clause | Decision (May 22, 2026) | Cascade |
|---|---|---|
| §13 — per-entity JSON sidecars in `analysis/` | **AMENDED.** SQLite + sqlite-vec + FTS5 becomes the substrate. JSON sidecars retired entirely — no migration, no fallback. Users start from zero data and re-run SCAN LOCAL to populate the new database. | First-class entities (Project, Topic, Narrative, Pattern) map to dedicated SQLite tables. Kernel-specific findings live in a generic `findings` table with `payloadJson` for open shapes. |
| §4–7 — Project / Topic / Narrative / Pattern entities | **PRESERVED.** Entity model stays intact; storage is SQLite. | TypeScript types in `packages/schema/src/` continue to be the contract; they describe rows now instead of JSON sidecar shapes. |
| §5 — Four-surface IA (PROJECTS / TOPICS / SESSIONS / PRACTICE) | **EXTENDED 2026-05-23** (PR #53 D1). IA grows to seven surfaces: PROJECTS / TOPICS / SESSIONS / PRACTICE + Effectiveness / Insights / Decisions as new top-level modes; Trust / Trends / Export attach to PRACTICE as lenses. | Session-graded outcome surfaces deserve top-level homes; cross-cutting analyses fit PRACTICE's four-lens audit framing. Curator feed from Rev3-F still lands as a top section on PRACTICE per the original IA decision. |
| §16 — "Autonomous Claude Code orchestrator with subagent delegation" descoped to v2.1+ | **AMENDED.** Curator + falsifier + MCP server in scope as part of this build. No half-measures. | Phases Rev3-E (curator/falsifier) and Rev3-G (MCP) are in-scope deliverables, not v2.1 punts. |

Reviewer-verified facts establishing the conflicts (still relevant for implementation planning): ~27 sidecars currently live at `apps/standalone/public/chat-arch-data/analysis/`; `packages/schema/src/` defines Project / Topic / Narrative / Pattern / Sentiment / CompositeOutcome / etc.; `packages/analysis/src/thresholds.ts` is the centralized config surface (lint-enforced); `MethodologyDisclosure.tsx`, `SourceAttribution.tsx`, `resolveClaude.ts`, `insights-ack.ts`, `knowledge-debt-state.ts` all exist.

**The locked v2 spec itself needs a separate amendment commit** updating §13 (substrate) and §16 (orchestrator scope) to reflect these decisions before the work lands. That's a Phase Rev3-A prerequisite.

## Premise

Rev 3's contribution is a **posture inversion**, not an architecture replacement. The locked v2 spec already commits to narrative-driven analysis with sentiment-aware actions; what it doesn't commit to is *making narratives appear to the user without being asked*. Rev 3 adds:

1. **Curator-first surfacing** — PRACTICE's four lenses get a top-of-page "what to look at now" feed, populated by a curator that ranks existing Narratives + the existing knowledge-debt + the existing CompositeOutcome substrate. The lenses themselves remain per the locked spec.
2. **Confidence ladder** with explicit rungs (replacing implicit binary "ready to surface" / "not ready"), centralized in `THRESHOLDS`.
3. **Generator / falsifier discipline** for Narrative encoding and corrective-prompt generation.
4. **Three loop closures** (feedback, decay/re-emergence, applied-rule outcome) — mapped onto existing `insights-ack.ts` + `knowledge-debt-state.ts` surfaces.
5. **Provenance fields** added to the existing Narrative shape.
6. **Outcome-correlation** as an additive field on CompositeOutcome-aware analyzer outputs.

The four verbs from the locked spec stay primary: **improve projects**, **sell skills with evidence**, **refine AI collaboration**. Curation is how those goals surface unprompted; it's not a fifth goal.

## Confidence ladder (centralized in THRESHOLDS)

Bayesian smoothing with a per-analyzer prior:

```
confidence = supporting / (supporting + contradicting + prior)
```

| Rung | Confidence gate | Additional gate | Unlocks |
|---|---|---|---|
| **Tier-1 (candidate)** | ≥ THRESHOLDS.narrativeRung.tier1 (0.33 placeholder) | supporting ≥ 1 | Visible in low-priority observations list only |
| **Tier-2 (established)** | ≥ THRESHOLDS.narrativeRung.tier2 (0.50 placeholder) | supporting ≥ 2 | Eligible for curator feed |
| **Tier-3 (promotable)** | ≥ THRESHOLDS.narrativeRung.tier3 (0.66 placeholder) | supporting ≥ 6 AND contradicting ≤ ceil(supporting / 6) | Eligible for `encode-as-pattern` / `generate-corrective-prompt` action |

Naming note: rungs are numbered tier-1 / tier-2 / tier-3 to avoid colliding with the existing `Pattern` entity (locked spec §4) and the `Promotable` adjective. Display labels can use "Candidate / Established / Promotable" — the numeric IDs are the schema-level identifiers.

Discipline (addresses iter-0 + iter-1 stat-rigor findings):

- **Joint gate feasibility.** The tier-3 confidence gate is set to 0.66 (not 0.75) so the gates are jointly satisfiable at the count-minimum: `supporting=6, contradicting=1` gives `6/(6+1+2)=0.667 ≥ 0.66` AND `1 ≤ ceil(6/6)=1` — both gates pass at the boundary. Iter-1 finding stat-rigor-iter1-001 demonstrated that 0.75 + count cap was infeasible.
- **User approval ≠ statistical validation.** Tier-3 unlocks `encode-as-pattern` / `generate-corrective-prompt` — those still require per-proposal user approval. The label "Validated" is reserved for post-application outcome verification (Closure C).
- **Prior is per-kernel** (not per-analyzer — the project's vocabulary is kernel; see §"Vocabulary alignment" below). Different kernels carry different evidence quality. Default prior=2 from ShopForge precedent; calibration plan below applies.
- **Calibration fail-safe.** A kernel whose `calibrationCompletedAt` is null in the registration metadata has its effective prior pinned to a very-high value (THRESHOLDS.narrativeRung.uncalibratedPrior, default 20) — making tier-3 unreachable until calibration lands. A banner-state surfaces "kernel X uncalibrated — tier-3 promotion disabled" so the missing calibration is visible, not silent.
- **All numeric values live in `packages/analysis/src/thresholds.ts`.** The required additions to the THRESHOLDS shape are: `narrativeRung.tier1`, `narrativeRung.tier2`, `narrativeRung.tier3`, `narrativeRung.defaultPrior`, `narrativeRung.uncalibratedPrior`, `narrativeRung.contradictingCapDivisor`, `narrativeRung.priorByKernel` (map keyed by kernel name), `curator.precisionAtKTarget`, `curator.precisionAtKHorizonDays`, `curator.falsifierRejectionBracket`, `curator.falsifierAccuracyFloor`. All centralized; no inline literals.

Calibration plan: hand-label **n ≥ 100 narratives per kernel** (iter-1 finding stat-rigor-iter1-002: n=50 with 20% held-out gave Wilson CI ±0.25-0.30 — inadequate for prior fit). Held-out ≥30 per kernel. MDE: detect ±0.10 false-promotion-rate difference at 80% power, α=0.05. Reframe as Bayesian update of the prior itself with explicit hyperprior; document the resulting prior credible interval, not a point estimate. Document calibration history alongside the existing `composite.weights` history block.

## Three closures (mapped onto existing infrastructure)

Triggers (ingest, viewer-open, periodic, feedback) fire the loop; the loop is its closures.

**Closure A — user feedback into ranking.** Iter-1 review found that the existing `apps/standalone/src/pages/api/insights-ack.ts` is an *idempotent acknowledgement ledger* with a hard `KNOWN_KINDS` allow-list (`its-contrast`, `knowledge-debt`, `reflexive`, `other`); it does NOT support `dismissed` state or `growthMultiplier` re-promotion — that semantic lives in `knowledge-debt-state.ts`. Rev 3 picks one path: **generalize `knowledge-debt-state.ts` to accept Narrative IDs**, renaming the on-disk ledger to a generalized entity-states form. Migration: per the schema-migration discipline below, with explicit per-sidecar transactional reload. The `insights-ack` endpoint stays as-is (just gains `narrative` kind for the binary acknowledge case; the richer state machine lives in the renamed knowledge-debt-state successor).

**Closure B — decay and re-emergence.** Reuses `THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier` semantics, generalized via the renamed entity-state ledger above. Saturation rule (iter-1 finding): after each dismissal, the per-Narrative growth multiplier raises by `THRESHOLDS.narrativeRung.dismissDecay` (default doubling: ×2 → ×4 → ×8). Cap at `THRESHOLDS.narrativeRung.maxDismissals` (default 4), after which the item is shelved permanently and visible only via an explicit "show shelved" affordance. Closes the iter-1 unbounded-nag failure mode.

**Closure C — applied-rule outcome.** Locked spec §9 already commits to two persistence destinations for `encode-as-pattern`: sidecar `analysis/patterns.json` and optional CLAUDE.md append. Rev 3 adds: after the optional CLAUDE.md append, the next-sessions watcher activates. Watcher closes by whichever fires first: (a) `THRESHOLDS.closureC.watcherSessionsN` sessions observed in the target project (default 5), (b) `THRESHOLDS.closureC.watcherWallClockDays` elapsed (default 60 days), (c) explicit user-side close. Wall-clock timeout emits a `WATCH_INCONCLUSIVE` Narrative at low feed priority — not silence. Project inactivity ≥ `THRESHOLDS.closureC.staleProjectDays` (default 30) before N is reached invalidates the watch entirely; a fresh watcher starts on project re-entry. Recurrence within the watch window → `RECURRING_AFTER_APPLIED` Narrative emitted. Non-recurrence → confidence-up on the original pattern.

Re-promotion family-wise correction (iter-1 finding): each re-emergence (Closure B) is a re-test of the same hypothesis. Per-Narrative prior += `THRESHOLDS.narrativeRung.repromotionPenalty` (default +1) on each dismissal so subsequent re-promotion attempts face a stiffer Bayesian threshold. Cap re-promotion attempts at K=3; document the resulting family-wise α inflation in the methodology disclosure on the curator surface.

These three closures together are what makes the loop a loop. Without them, the curator is a periodic recommender, not a learning system.

## Intelligence layer (generator / falsifier discipline)

**Two roles, separately invoked.** Both run via the existing `resolveClaude.ts` subprocess pattern with `claude -p`:

- **Generator** runs the per-analyzer skill (existing `/mine-corrections`, planned `/mine-decisions`, planned `/mine-playbook`, and a new `/curate` skill for ranking).
- **Falsifier** is structurally separate: different agent type, different system prompt, different prompt template. It verifies each generator finding's `evidenceChain` cites real session turns whose content supports the claim. Findings whose citations fail the falsifier are dropped before any user-visible surface.

Subprocess failure handling (addresses iter-0 adversarial finding):

- Probe `claude --version` at startup; if absent, the curator surface enters a banner-state "claude CLI not detected — curator paused."
- Plan-usage throttling (HTTP 429 / timeout): retry once with exponential backoff; on persistent failure, requeue and surface "curator paused (plan-usage throttle)" banner.
- `ANTHROPIC_API_KEY` is honored as fallback when present in env AND the user has explicitly opted in via a `chat-arch.dev` toggle. Off by default per the project's plan-billing default ([feedback_claude_code_not_api](C:\Users\Bryce\.claude\projects\c--Users-Bryce-Projects-chat-arch\memory\feedback_claude_code_not_api.md)).
- Generator and falsifier output are written atomically (tmp-file + rename) to avoid partial-write corruption.

**Meta-validation of the falsifier itself** (addresses iter-0 adversarial finding): periodic spot-check — sample 10 falsifier verdicts per week, have either the user or a different model role re-judge them, log to `analysis/falsifier-accuracy.json`. If accuracy drifts below 0.8 (THRESHOLDS-resident), surface a banner.

**The curator + falsifier scope question.** Locked spec §16 descopes "autonomous Claude Code orchestrator with subagent delegation" to v2.1+. Rev 3's curator + falsifier IS this pattern. So §0 above lists it as a lock-break decision. If the user keeps the §16 lock, the intelligence layer in this section is v2.1 scope; if the lock breaks, v2.0.

## Provenance fields (additive to existing Narrative)

Existing `packages/schema/src/narrative.ts` shape (per locked spec §4.4): `id, projectId, sessionIds[], sentiment, title, body, evidence[], generatedAt, actionType`. Existing `NarrativeEvidence` shape: `{ sessionId, anchor?, excerpt? }`.

Rev 3 additions — all optional with documented defaults (iter-1 fix for non-optional fields breaking back-compat):

```typescript
interface Narrative {
  // ...existing fields...
  schemaVersion?: 1 | 2;     // 1 = pre-Rev3; 2 = with provenance. Defaults to 1 on read of legacy entries.
  intent?: string;
  observation?: string;
  inference?: string;
  attributedTo?: 'deterministic' | 'llm' | 'mixed';  // defaults to 'deterministic' on legacy
  verifiedAt?: string;
  confidence?: number;        // defaults to backfilled value computed at migration
  supportingCount?: number;   // defaults to evidence.length on legacy
  contradictingCount?: number; // defaults to 0 on legacy
  correlatedOutcome?: number;
}

// Extend existing NarrativeEvidence shape (additive, NOT a parallel array):
interface NarrativeEvidence {
  sessionId: string;
  anchor?: string;
  excerpt?: string;
  turnIndex?: number;  // NEW — added in schemaVersion: 2 for falsifier alignment
}
```

**No parallel `evidenceChain` array.** Iter-1 finding correctly flagged that introducing `evidenceChain` alongside `evidence[]` creates two-arrays-to-read drift. Instead, extend `NarrativeEvidence` with `turnIndex?` — falsifier reads `evidence[]` and uses `turnIndex` when present.

**Backfill migration** at Phase Rev3-A: a one-shot kernel runs over `analysis/narratives.json`, computes `confidence` from `evidence.length` against the per-kernel prior, sets `attributedTo='deterministic'` for narratives produced by the existing rule-based `discoverNarratives` kernel, bumps each entry to `schemaVersion: 2`, writes back atomically. Existing `validateNarrative()` extends to accept either schema version. Named migration test: `packages/schema/src/narrative.migration.test.ts` with assertions for (a) legacy `schemaVersion: 1` parses unchanged, (b) backfill produces deterministic confidence values, (c) round-trip stability, (d) `validateNarrative()` accepts both versions.

## Outcome-correlation (additive to existing CompositeOutcome substrate)

Each Narrative gains an optional `correlatedOutcome` field: the mean composite-outcome score of sessions cited in `evidence[]` minus the project's baseline composite score. Range: roughly `[-1, +1]`. Computed at narrative-write time via join to `analysis/composite-outcomes.json`.

Discipline (addresses iter-0 + iter-1 stat-rigor findings):

- **Length floor.** Tie-breaker is gated on `evidence.length ≥ 5` — at smaller counts the SE on the cited-side mean dominates the difference and ranking becomes noise (iter-1 finding stat-rigor-iter1-004).
- **Significance test.** Compute Welch's t-statistic (or non-parametric permutation difference) of cited-session composite vs. non-cited project sessions. Display the correlation tag only when |Δ|/SE exceeds a threshold pinned in `THRESHOLDS.curator.outcomeCorrelationSignificance` (placeholder 1.96, calibrated empirically). Show SE alongside the correlation in the SourceAttribution side-column tag.
- **Falsifier verifies non-confounded.** Specifically: the falsifier runs a permutation test resampling project sessions to confirm the observed Δ is unlikely under H0 of no cited-vs-baseline difference. Implementation pinned in the falsifier prompt template.
- **Disclosure is structural, not just textual.** Surface as a side-column tag with explicit "correlation, not causation" label.
- **Ranker uses outcome correlation only as a tie-breaker** within a tier. Two tier-3 narratives — the one with the better significance-gated correlation surfaces first. A tier-1 narrative does not jump tiers because of correlation.

## Surface design (uses existing components)

The Playbook page's structural pattern (synoptic counters → ranked list → cards with progressive disclosure of examples → page-level methodology disclosure) becomes the **viewer convention for any kernel-backed surface**, implemented entirely with existing components (iter-1 fix for proposing a new `MethodHint` when `SourceAttribution` already serves the role):

- Page-level methodology disclosure → `packages/viewer/src/components/MethodologyDisclosure.tsx` (already shipped, used by InsightsMode + EffectivenessMode).
- Cell-level honesty/source-attribution micro-labels → **extend `packages/viewer/src/components/SourceAttribution.tsx`** by widening its `AttributionKind` union with the new rungs: `'tier1' | 'tier2' | 'tier3' | 'falsifier-verified' | 'llm-derived' | 'deterministic-with-prior'`. Single component, no parallel `MethodHint`.
- Progressive disclosure of example lists → reuse the Playbook page's existing collapse pattern.

**Where the curator feed lives.** Per locked spec §6, primary nav is the left sidebar; top header is informational only. The curator feed is added as a top section on PRACTICE (per §5.4), above the four lenses. It is NOT a new top-level surface — that would conflict with the locked four-surface IA.

## Vocabulary alignment

Iter-1 review flagged that the iter-1 draft used "analyzer" as a load-bearing noun ~18 times. The project convention is **kernel** (`packages/analysis/src/` "Shared cloud-mapping + clustering + correction-recall kernels" per CLAUDE.md); the existing files are `detect*` / `discover*` / `compose*` / `audit*` prefixes. This Rev 3 uses **kernel** throughout for the analysis-package modules. The "registry" concept (per-kernel prior, per-kernel `minSessionsForConfidence`, per-kernel `calibrationCompletedAt`) lives in `THRESHOLDS.narrativeRung.priorByKernel` as a flat map keyed by kernel name — no new `analyzers/` directory or registry class is introduced. If the keyword "analyzer" appears anywhere in this doc outside this paragraph, it's a residual rename — treat it as a kernel reference.

## Validation metrics (pinned)

- **Curator precision@k**: k = 10 (THRESHOLDS.curator.precisionAtKWindow). Engagement counted iff event (star OR explicit-action OR `engagedAt`) occurs within THRESHOLDS.curator.precisionAtKHorizonDays (default 7) of **first surfacing only**. Items whose 7-day window hasn't closed at evaluation time are excluded from both numerator and denominator (iter-1 finding stat-rigor-iter1-006). Target: > THRESHOLDS.curator.precisionAtKTarget (placeholder 0.30) within first calibration window.
- **Falsifier rejection rate**: pre-launch placeholder bracket [0.20, 0.50] in `THRESHOLDS.curator.falsifierRejectionBracket`, explicitly labeled as such. Calibration: 4-week empirical window analogous to the `CHATARCH_THRASH_DETECT` calibration plan; re-derive bracket from observed data.
- **Cross-kernel reuse rate**: fraction of kernel runs that read sibling-kernel outputs vs. re-derive from raw sessions. Should grow as the ecosystem matures.
- **Cold-start honesty**: per-kernel `minSessionsForConfidence` declaration in `THRESHOLDS.narrativeRung.minSessionsByKernel`. Kernels report uncalibrated when below; their findings cannot exceed tier-1 until threshold is met.
- **Falsifier meta-accuracy**: rolling 4-week window (n=40 verdicts), trigger on Wilson lower bound < `THRESHOLDS.curator.falsifierAccuracyFloor` (placeholder 0.8). NOT point estimate on n=10/week (iter-1 finding stat-rigor-iter1-003: that fires ~26% of weeks on noise at true accuracy 0.9). Document false-alarm probability of the chosen rule next to the threshold.
- **Plan-usage cost-per-curator-run**: labeled as "plan usage (API-equivalent)" per the project's billing convention. Trending down with prompt caching expected.

LoCoMo is explicitly NOT the benchmark — it tests QA memory; this is recommender evaluation.

## Phased delivery (post §0 amendments)

With §13 and §16 amended, the phasing folds in SQLite substrate AND curator/falsifier/MCP as in-scope:

**Phase Rev3-A — SQLite substrate + locked-spec amendment commit.** Stand up SQLite + sqlite-vec + FTS5. Create initial tables for first-class entities (Project, Topic, Narrative, Pattern, Session, SessionMessage, SessionRevision) + generic `findings` + `analyzers` registry + `schema_migrations`. Centralize THRESHOLDS additions (`narrativeRung.*`, `curator.*`, `closureC.*`). Amend `chat-arch-v2-spec.md` §13 + §16 in the same PR so the spec and code agree on day 1. Extend `NuclearReset` to sweep orphan JSON files under `chat-arch-data/analysis/` alongside its existing IndexedDB clears. *Gates:* SDK returns expected rows from a seeded-fixture test corpus; empty-database initial state renders the "NO DATA YET" landing screen correctly; native-module CI spike passes (better-sqlite3 + sqlite-vec prebuilds on the runner image).

**Phase Rev3-B — Narrative provenance + confidence ladder.** Add provenance fields (intent, observation, inference, attributedTo, verifiedAt, confidence, supportingCount, contradictingCount, correlatedOutcome) to the Narrative table. Backfill kernel runs once over existing Narratives. *Gate:* named `narrative.migration.test.ts` passes; existing `validateNarrative()` accepts both schemaVersion shapes.

**Phase Rev3-C — Closure A wiring (feedback ranking).** Generalize `knowledge-debt-state.ts` semantics into a renamed `entity-states` ledger that handles Narratives + knowledge-debt items under one shape. `insights-ack.ts` gains a `narrative` kind for the binary-ack case; the richer state machine lives in the renamed ledger. *Gate:* a surfaced Narrative can be dismissed and re-promoted via the existing growth-multiplier mechanism.

**Phase Rev3-D — Closure B wiring (decay / re-emergence).** Saturation rule (×2/×4/×8 cap K=3) lands on the generalized ledger. Per-Narrative re-promotion-penalty prior += 1 on each dismissal. *Gate:* a previously-dismissed Narrative re-enters the feed only after evidence growth exceeds the multiplier; capped re-promotion attempts visible in the audit table.

**Phase Rev3-E — Closure C wiring (applied-rule outcome) + Pattern.falsifierStatus.** Next-sessions watcher (N=5, wall-clock 60d, project-inactivity 30d) emits `RECURRING_AFTER_APPLIED` or `WATCH_INCONCLUSIVE`. Pattern entity gains `falsifierStatus: 'verified' | 'skipped-by-user' | 'unavailable'`; encode-as-pattern flow defaults to falsifier-gating, with explicit override checkbox that records the bypass. *Gate:* an applied pattern visibly closes its watcher within the window; bypass path produces an auditable Pattern row.

**Phase Rev3-F — Curator + falsifier agents (formerly v2.1 per §16, now in-scope).** Curator agent (`/curate` skill, `claude -p`) ranks tier-2 and tier-3 Narratives + outcome-correlation tie-breaks. Falsifier agent (separate skill, separate prompt template) verifies citations + confounder-tests outcome-correlation claims. Meta-validation: rolling 4-week Wilson lower bound on falsifier accuracy. Subprocess fallback per §"Subprocess fallback". *Gate:* falsifier rejection rate inside bracket; meta-accuracy stable; user engages with ≥1 surfaced item per week.

**Phase Rev3-G — Outcome-correlation rendering + significance-gated ranker.** Welch's t / permutation test gates the correlation tag visibility; SourceAttribution widens to include `falsifier-verified` / `correlation-significant` kinds. *Gate:* correlation tags visible only when |Δ|/SE exceeds threshold; tie-breaker only fires on evidence ≥ 5.

**Phase Rev3-H — MCP server (formerly v2.1 per §16, now in-scope).** Standalone MCP server exposes the data SDK as tools to external claude sessions. Read-only by default; narrow-scope tool surface (no arbitrary `readFile`, no `claude -p` exec from inside the server, working-dir scoped to chat-arch-data/). Localhost-bind only in v2.0; remote MCP-over-HTTP descoped as a separate concern. *Gate:* the same query returns equivalent results in the viewer and from an external claude session.

**Phase Rev3-I — Documentation hygiene + CLAUDE.md updates.** Concrete deliverable, not deferred: update CLAUDE.md "Data on disk" section for the new SQLite DB file + the renamed entity-states ledger + Narrative schemaVersion 2 PII expansion. Add `*.db / *.db-wal / *.db-shm` to `.gitignore`. Update README to formalize hosted-viewer divergence (chat-arch.dev stays JSON-sidecar-only as a deliberately-scoped demo of the local pipeline). *Gate:* fresh contributor can read CLAUDE.md and correctly enumerate what's on disk and what carries PII.

## Migration discipline (when locked-spec data files evolve)

iter-0 ship-readiness flagged missing migration detail. For each Rev 3 phase that touches a sidecar shape:

- **Schema-version bump** in `EXPORTER_VERSION` or `HEURISTIC_RECALL_VERSION` per existing convention.
- **Per-sidecar transactional reload** — one sidecar is fully migrated or fully not; partial reload is a build failure, not silent corruption.
- **Reversibility** — keep the prior shape readable for ≥1 minor version so users can downgrade. Existing `validateNarrative()` pattern extends here.
- **Migration tests** as named CI gates, not just "regression-free."

## Staging discipline (no PII regression)

Iter-0 ship-readiness flagged the .gitignore + .githooks/pre-commit gap. Rev 3 must not regress the existing PII discipline:

- All new sidecars added under `apps/standalone/public/chat-arch-data/analysis/` are covered by the existing wildcard.
- The pre-commit hook (`.githooks/pre-commit`) scans for populated manifest.json today; extend it to scan any new sidecar with user-content (Narratives carry quoted excerpts; that's PII).
- Project CLAUDE.md "Data on disk" section gets updated for each new sidecar.

## Subprocess fallback (claude -p)

- **Probe at startup.** `claude --version` runs once per curator-invocation entry point; result cached for the run. Failure → "claude CLI unavailable — curator paused" banner; kernel runs queued.
- **Throttle handling.** Plan-usage 429 / timeout → exponential backoff, retry once; persistent failure → requeue + banner.
- **API-key fallback** OFF by default (project convention is plan billing). User must opt in explicitly via the `chatArchCuratorApiKeyOptIn` localStorage flag set in the LOCAL `pnpm dev` viewer only (hosted chat-arch.dev has no curator so no toggle there). The flag gates whether the env-var is *read* at subprocess invocation; the `ANTHROPIC_API_KEY` value itself is NEVER persisted by chat-arch — it must come from process env at runtime. A startup check refuses to launch the API-fallback path if the toggle is set but the env var is missing, surfacing "opt-in set but ANTHROPIC_API_KEY not in env — refusing to prompt for it."

## SQLite write contract

With SQLite as the substrate (§0 amendment), the JSON-sidecar atomic-write headaches are replaced by proper transactions. Contract:

1. **WAL mode + `synchronous=NORMAL`** for the connection. Unlimited reader concurrency; single writer per process.
2. **Single-writer pattern across processes.** Multiple kernel subprocesses serialize via `BEGIN IMMEDIATE` with documented retry/backoff on `SQLITE_BUSY` (50ms exponential up to 1s, then surface a "writer busy" banner and queue). For long-lived curator runs, a writer-broker pattern is acceptable but not required — `BEGIN IMMEDIATE` with retry handles the chat-arch concurrency profile (a few kernels, not hundreds).
3. **Run state inside the same transaction.** Each kernel's batch writes findings AND updates its registry row (`analyzers` table with `name, version, lastRunAt, calibrationCompletedAt, prior`) in the same `BEGIN IMMEDIATE` ... `COMMIT`. Crash mid-batch → WAL rollback → kernel's `lastRunAt` is unchanged → next invocation re-derives the same batch. Idempotency required (deterministic ordering, stable IDs).
4. **Schema migrations.** Versioned via a `schema_migrations` table (migration_id, applied_at). Each Rev 3 phase that adds tables/columns ships a migration script; tests assert idempotence (running the migration twice is a no-op).
5. **Native-module CI compatibility.** `better-sqlite3` + `sqlite-vec` are prebuild-binary native modules. Phase Rev3-A includes a CI spike: confirm prebuilt binaries exist for the pinned Node version on the Ubuntu CI runner image. Document postinstall behavior under `pnpm`. Add `optionalDependencies` escape or a pure-JS fallback shim if prebuilds prove unreliable.

## Zero-data start (no migration)

No migration kernel, no transition window, no fallback path. The new SQLite schema is the only persistence; the existing ~27 JSON sidecars under `apps/standalone/public/chat-arch-data/analysis/` are orphaned and ignored. Rationale: testing from zero is desirable on its own (forces every code path to handle the empty case correctly), and the existing data isn't load-bearing for any active workflow.

User-facing flow on first launch of the new build:
1. Empty SQLite database initialized with the Phase Rev3-A schema.
2. Viewer shows the existing "NO DATA YET" landing screen (already implemented).
3. User clicks **SCAN LOCAL** as they would today; the exporter walks `~/.claude/projects/` + Cowork paths, writes directly to SQLite, kernels run, embeddings compute.
4. The orphaned JSON files in `chat-arch-data/analysis/` can be manually deleted by the user or left in place — the new code path never reads them. NuclearReset's existing "delete all" action gets a small extension to sweep the orphan JSON directory alongside its current IndexedDB clears.

This simplification removes:
- The migration kernel (no `migration_state` table, no per-sidecar transformers)
- The transition window (no "SQLite first, JSON fallback" SDK logic)
- The reversibility commitment (no minor-version JSON read-path retention)
- The migration test family (replaced with normal schema/correctness tests)

Schema correctness tests still ship — but they're standard "SDK returns expected rows from seeded fixtures" tests, not "JSON-to-SQLite round-trip" tests.

## Open decisions (user-pinning, not Claude's)

1. **§13 lock-break:** SQLite substrate or stay on JSON sidecars? Iter-1 assumes JSON sidecars.
2. **§16 lock-break:** curator + falsifier in v2.0 or v2.1? Iter-1 marks Phase Rev3-E/F as v2.1 default.
3. **Curator cadence:** daily / weekly / viewer-open only? Defaults to viewer-open + on-new-session in this draft.
4. **PII handling on previews:** default-blur with reveal-on-click before any curator surface ships. Pinned as Phase Rev3-B gate.
5. **MCP server posture:** entirely descoped from this Rev 3, as it correlates with §16. If §16 breaks, MCP follows in a separate amendment.

## User decisions captured (May 22, 2026)

All five iter-2 exit-punch-list items resolved:

1. **§13 lock-break → SQLite locked in.** Substrate becomes SQLite + sqlite-vec + FTS5. No JSON migration — existing data is orphaned, users start from zero and re-run SCAN LOCAL. Locked spec gets an amendment commit as a Phase Rev3-A prerequisite.
2. **§16 lock-break → full v2.1 features in scope.** Curator + falsifier + MCP server land as part of this build. No half-measures. Phase Rev3-F, Rev3-G, Rev3-H are in-scope deliverables.
3. **CLAUDE.md hygiene → always do.** Promoted to Phase Rev3-I, a concrete deliverable with its own gate.
4. **Pre-commit hook → stay surgical to manifest.json.** Wildcard `.gitignore` + new `*.db / *.db-wal / *.db-shm` patterns cover everything else.
5. **Falsifier-gating on `encode-as-pattern` → yes, with auditable override.** Default gate is falsifier-verified evidence. User can override via explicit checkbox in the encode-as-pattern flow; Pattern entity carries `falsifierStatus: 'verified' | 'skipped-by-user' | 'unavailable'` for auditability.

## Cost accounting (per project convention — plan usage, API-equivalent)

Iter-0: 5 reviewer dispatches × ~50k tokens each ≈ 250k. Iter-1: 5 reviewer dispatches × ~45k each ≈ 220k. Total ≈ 470k tokens of plan usage. Past the 300k nominal /review-loop ceiling; under the user's explicit "until clean" extension. All findings from both iterations survived falsification — no drift, no off-topic claims dropped.

## Reviewer findings disposition

Every iter-0 and iter-1 finding survived falsification against the actual codebase, locked spec, and existing endpoints. iter-2 fix pass addressed the highest-stakes load-bearing items via targeted edits (vocabulary alignment, atomicity contract, MethodHint→SourceAttribution reuse, calibration fail-safe, Pattern.falsifierStatus, etc.). Outstanding speculative items are now resolved by the §0 amendments above — they no longer block landing.

## Explicit non-goals

- **Letta dependency** (concepts useful; SDK adds nothing chat-arch needs)
- **Graph DB / separate object store** (SQLite handles every query pattern we have)
- **API-billed SDK as default** (project convention is `claude -p` plan billing; user opt-in for API only)
- **Auto-apply confidence rung** (tier-3 always requires explicit user approval per proposal)
- **Generic copy-as-markdown UI affordance** (only when a downstream claude-code workflow consumes it)
- **Learned ML ranking** (start rule-based; promote only if rule ranker stalls on precision@k)
- **Map-reduce summarization infrastructure** (don't pre-build for problems substrate + current models already solve — harness-pruning rule)
- **Removing `packages/analysis`** (locked spec §16 partial — this specific lock stands)
- **LLM-based sentiment** (locked spec §15; v2.1 scope still)
- **Remote MCP-over-HTTP** (Phase Rev3-H ships localhost-bind only; remote is a separate amendment if ever)

## Net

Iter-0 Rev 3 was a wholesale rethink that overrode locked decisions. Iter-1 Rev 3 is **additive proposals** that respect the locked v2 spec's substrate (JSON sidecars), entity model (Project / Topic / Narrative / Pattern / Sentiment), four-surface IA, and tier model. The good ideas — confidence ladder, three loop closures, generator/falsifier discipline, provenance fields, outcome-correlation — land within existing surfaces and reuse existing infrastructure (`THRESHOLDS`, `MethodologyDisclosure`, `insights-ack`, `knowledge-debt-state`, `resolveClaude`). Two strategic items (SQLite substrate, MCP server / agent orchestration) remain as user-decision lock-break questions in §0.

The biggest lesson: a "first-principles" plan written without reading the locked spec first is a hallucination of architectural authority. The next iteration of any plan in this repo should start with `chat-arch-v2-spec.md`.
