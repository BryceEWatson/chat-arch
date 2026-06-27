# Plan — honest disclosure of skipped / withheld / unverified state

Fixes three related "silent disclosure" issues on the DECISIONS + PRACTICE
surfaces. All three share one theme: the UI shows *nothing* in a state that
should show *an explanation of why there's nothing*, so "withheld / skipped /
unverified" reads as "no data / verified."

## Source of truth

- Issue [#122](https://github.com/BryceEWatson/chat-arch/issues/122) (bug) — `mine-decisions` clustering silently no-ops when Ollama (embeddings) is unreachable.
- Issue [#119](https://github.com/BryceEWatson/chat-arch/issues/119) (rigor) — cluster landed-rate floor (n<8) silently blanks; the other two floors already disclose.
- Issue [#120](https://github.com/BryceEWatson/chat-arch/issues/120) (trust) — scaffold curator/falsifier surfaced as live; findings shown VERIFIED though unverified.

Read in full via `gh issue view`. Evidence in each issue verified against the
code (see "Grounding" below).

## PR structure decision (contestable)

**One PR, three commits** (one per issue), closing all three. Rationale:
- The recent operator rule "keep open PRs to 1 only — consolidate onto a single
  integration branch/PR" (memory `feedback_single_open_pr`) is the strongest,
  most specific constraint and points to one PR.
- The Claude-Code-paced override explicitly allows bundling into 1–2 PRs when
  Claude Code is doing the implementation.
- The three issues are one coherent theme (honest disclosure) and overlap in
  files (#122 + #119 both touch `DecisionsMode.tsx` + the decision-clusters
  path). Splitting would create artificial churn and >1 open PR.
- Each issue gets its own commit so it stays independently reviewable.

If the operator wants #122 split out to merge independently of the more
subjective #119/#120 disclosure-copy changes, that's a cheap reversal — flag at
the plan-approval gate. **This is a scope decision surfaced for consent, not a
silent choice.**

## Grounding (measured, from the code)

- `cluster-decisions-cli.ts` `main()` calls `embed()` at line 240; on Ollama-down
  it throws → `main().catch()` writes stderr + `process.exit(1)`; `decision-clusters.json`
  is never written. Tests cover only the pure functions (`buildDecisionClusters`,
  `parseArgs`, `normalizeDecision`), not `main()`.
- `embed()` (`packages/exporter/src/embeddings/index.ts`) throws on connection
  failure; wrapping the single `embed()` call catches the Ollama-down case
  (including mid-run failures), which `isOllamaAvailable` pre-probing cannot.
- The skill (`.claude/skills/mine-decisions/SKILL.md` Stage 3) **pre-probes**
  Ollama and *bypasses the CLI entirely* when the probe fails → in that path
  `decision-clusters.json` is never written either (a second silent path the
  issue's CLI-only fix wouldn't cover).
- `loadDecisionClustersFile` (`decisionsLoader.ts`) casts the parsed body to
  `DecisionClustersFile` and only validates `Array.isArray(body.clusters)`, so
  added optional fields (`skipped`/`skipReason`) pass through untouched — **no
  loader change needed.**
- `DecisionsMode.tsx`: the RECURRING section renders only when `clusters.length > 0`
  (≈ line 484), so a skip is indistinguishable from "no clusters." The per-cluster
  landed-rate renders only `cl.landedRate !== null` (≈ lines 503–509) with **no**
  "n too low" note — that's the silent floor in #119. The per-*kind* rate (≈ lines
  362–380) already discloses ("landed-rate hidden — n=… of {minN}"), as do TrustMode
  and TrendsMode — so #119 only needs the cluster path brought to parity.
- `THRESHOLDS.display.minNForRate = 8` (the n<8 floor).
- `CuratorFeed.tsx`: lead copy asserts items tagged VERIFIED "passed the
  falsifier" (lines 74–83) and the empty states (lines 99–111) carry no scaffold
  disclaimer. `curatorFeedClient.ts` has **no provenance field** distinguishing a
  real verdict from a scaffold placeholder. `/curate` + `/falsify` SKILL.md are
  `status: scaffold`; F3/F4/F8 kernels run only in tests; the MCP server has no
  transport. There is **no MCP "live" affordance in the viewer** (grep clean), so
  #120 is scoped to CuratorFeed only.
- `EXPORTER_VERSION = '1.10.0'` (`packages/exporter/src/analysis/index.ts`).

## In scope

### Issue #122 — soft, visible clustering skip
1. **Schema** (`packages/schema/src/decision.ts`): add to `DecisionClustersFile`
   two additive optional fields: `skipped?: boolean` and
   `skipReason?: 'embeddings-unavailable'`. Update the doc comment.
2. **CLI** (`packages/exporter/src/cli/cluster-decisions-cli.ts`): refactor the
   embed-and-build block in `main()` into an exported, testable async helper
   (e.g. `buildClustersFileOrSkip(decisions, opts, embedFn, embedOpts)`) that:
   - returns `{ generatedAt, clusters }` on success;
   - on `embedFn` throw, returns `{ generatedAt, clusters: [], skipped: true,
     skipReason: 'embeddings-unavailable' }` and writes a stderr note (no throw);
   - returns `{ generatedAt, clusters: [] }` (NOT skipped) when `decisions` is empty.
   `main()` writes whatever the helper returns and exits 0 on a skip. Genuine
   errors (bad args, unreadable input, vectors/decisions length mismatch on a
   *successful* embed) still hard-fail via `main().catch()` → exit 1.
3. **Skill** (`.claude/skills/mine-decisions/SKILL.md` Stage 3 + Stage 5 + Error
   handling): stop using the Ollama pre-probe to *bypass* the CLI. Always run the
   CLI when there are ≥2 classified decisions; it now soft-skips and writes the
   marker, so `decision-clusters.json` is always written in the "would-have-clustered"
   case. Keep the ≥2-classified guard (with <2 there's nothing to cluster — not a
   skip). Note `clusterCount: 0` + `decision-clusters.json skipped:true` on the
   skip path in Stage 5.
4. **Viewer** (`DecisionsMode.tsx`): when `clustersFile?.skipped`, render the
   RECURRING section header with a skip note ("Clustering skipped — embeddings
   unavailable (Ollama not reachable). Recurring-decision detection is optional;
   classification above is unaffected. Start Ollama and re-MINE to populate this.")
   instead of hiding the section. `data-testid="decisions-recurring-skipped"`. The
   note is styled **muted/informational, NOT a warning color** (per operator-empathy
   review — a soft optional-skip must not read as a must-fix error or train
   banner-blindness). The "classification above is unaffected" clause is load-bearing:
   it stops the optional skip from reading as a blocking failure.

**Endpoint (`mine-decisions.ts:197-227` `probeOutcome`) — deliberately UNCHANGED.**
Issue #122 names this file, so the non-change is a decision, not an omission: with
the soft-skip the CLI now exits 0, the skill still writes `decision-status-*.json`
`status:'complete'` (clustering is an optional sub-step, not the run), so
`probeOutcome` correctly reports the mine run *succeeded*. The clusters-file marker —
not the endpoint — is what conveys the optional-skip detail to the viewer. The
issue's "**and/or** a `decision-status-*.json status:'skipped'`" is satisfied by the
`decision-clusters.json` marker leg; the per-request status-file leg is intentionally
NOT used because the CLI has no `--request-id` (the skill owns the request-scoped
status file, and it reports run-level `complete`, which is honest).

### Issue #119 — cluster landed-rate floor disclosure
5. **Viewer** (`DecisionsMode.tsx` RECURRING rows): when `cl.landedRate === null`,
   render a muted "landed-rate hidden — n={cl.landedDenom} of {minN}" note (reusing
   `lcars-decisions__rate--hidden`), mirroring the per-kind / Trust / Trajectory
   pattern. `data-testid="cluster-rate-hidden-<id>"`. **`landedDenom` is always a
   number** (`DecisionPattern.landedDenom: number`, set unconditionally as
   `decided.length` in `buildDecisionClusters` line 189), so the "n=k of 8" message
   is always well-formed even when `landedRate` is null — no schema/CLI change needed
   for #119, viewer-only.

### Issue #120 — scaffold disclosure on the curator feed
6. **Viewer** (`CuratorFeed.tsx`): add a module constant
   `CURATOR_PIPELINE_LIVE = false`. **Flip-guardrail (per vision review):** the
   constant is a coarse scaffold-era global gate — it must NOT be flipped `true`
   until **per-item verdict provenance** exists (F4 falsifier writing a real
   per-finding verdict, surfaced via a provenance field on `curator-feed.json`).
   Document this directly in the code comment so a future contributor can't flip
   it and silently re-introduce blanket "VERIFIED" for items that never passed a
   real falsifier. (That provenance field is itself out of scope here — see
   Out-of-scope; the guardrail comment is what prevents the regression.) While not
   live:
   - render a persistent scaffold note (`data-testid="curator-scaffold-note"`,
     **muted/informational styling**, NOT the peach drift-banner) stating the
     curator/falsifier are a scaffold, not yet wired to production, and any
     VERIFIED/UNVERIFIED tags are placeholders;
   - reword the lead so it does **not** assert "VERIFIED = passed the falsifier"
     as fact (gate that sentence behind `CURATOR_PIPELINE_LIVE`);
   - in `CuratorFeedRow`, when not live, present the falsifier tag as a placeholder
     (append "(placeholder)" / `--placeholder` class + tooltip) rather than an
     affirmative verdict;
   - add the scaffold disclosure to the empty states too.
7. **CSS** (`packages/viewer/src/styles.css`): add `lcars-curator-feed__scaffold-note`
   (**muted/informational** — a quiet caption, NOT the peach warning of the drift
   banner, since it's permanent), `lcars-decisions__recurring-skip` (muted), and a
   curator falsifier `--placeholder` treatment (de-emphasized). Reuse existing tokens.

### Cross-cutting
8. **Tests**:
   - `cluster-decisions-cli.test.ts`: new case — a throwing `embedFn` yields a
     file with `skipped: true`, `skipReason: 'embeddings-unavailable'`, `clusters: []`;
     and the empty-decisions case is NOT marked skipped.
   - `DecisionsMode.test.tsx`: (a) `clustersFile.skipped` renders the skip note +
     no recurring rows; (b) a cluster with `landedRate: null` renders the
     "landed-rate hidden — n=… of 8" note; (c) **absence assertion** — a normal
     clusters file (no `skipped`, non-null `landedRate`) renders neither
     `decisions-recurring-skipped` nor `cluster-rate-hidden-<id>`.
   - New `CuratorFeed.test.tsx`: scaffold note present; lead does not assert
     "passed the falsifier" as fact while scaffold; a feed item with
     `falsifierStatus: 'verified'` renders as a placeholder (not an affirmative
     verdict) while scaffold.
9. **Docs**:
   - `CHANGELOG.md`: new `[1.11.0]` entry covering all three fixes (note the
     version-reconcile caveat vs. the 1.10.0/#113 slot already recorded).
   - `EXPORTER_VERSION` → `1.11.0`. **Contestable Tier-1 decision (per architecture
     review), surfaced not asserted:** `decision-clusters.json` is *skill-written*,
     not exporter-emitted, so one could argue the exporter version shouldn't move
     for it. Decision: **bump anyway.** Rationale — (a) `EXPORTER_VERSION` is the
     *bundle-wide* provenance label in `meta.json`, and CLAUDE.md's documented
     trigger is literally "the shape of an existing artifact changes," which this
     is; (b) precedent: 1.9.0 bumped for the decisions pipeline whose classification
     is *also* skill-merged into `decisions.json`; (c) the version is what lets an
     operator correlate "this bundle's `decision-clusters.json` may carry
     `skipped`/`skipReason`" with the CHANGELOG. If the operator prefers to leave
     `EXPORTER_VERSION` and bump only the SKILL.md doc + CHANGELOG, that's a clean
     alternative — flag at the plan-approval gate.
   - `CLAUDE.md` "Data on disk" / decisions-sidecar section: note
     `decision-clusters.json` may now carry `skipped`/`skipReason`.
   - `.claude/skills/mine-decisions/SKILL.md`: the Stage 3/5 changes above.

## Out of scope / Deferred (do NOT build)

- Wiring the F3 curator ranker / F4 falsifier / F8 meta-validation kernels into a
  production path, or the H3 MCP stdio transport. #120's own severity note says
  these "are project work"; only the *disclosure* is in scope. `CURATOR_PIPELINE_LIVE`
  is the single switch that flips when they land.
- Adding a real verdict-provenance field to `curator-feed.json` (would require
  the scaffold skills to write it). The boolean gate is the bounded fix.
- Changing clustering thresholds, the embedding model, or the landed-rate floor
  value itself (#119 is disclosure-only).
- Any change to `mine-corrections` clustering (sibling CLI) — not in these issues.
- Reworking the Ollama pre-probe into the CLI (the skill keeps an optional probe
  only for a friendly log line; the CLI owns the skip).

## Definition of done (testable)

- `pnpm lint` + `pnpm test` + `pnpm build` green from the repo root.
- New unit tests above pass and assert the skip-marker shape + both disclosures +
  the scaffold gating.
- **Real-app exercise:** rebuild the viewer, run `pnpm dev`, and drive the live
  app via the browser preview. **Forcing the skip state** (so the browser check is
  actually reachable, not dependent on Ollama happening to be down): hand-write
  `apps/standalone/public/chat-arch-data/analysis/decision-clusters.json` as
  `{"generatedAt":<ms>,"clusters":[],"skipped":true,"skipReason":"embeddings-unavailable"}`
  and reload — this is exactly the file the soft-skip path writes.
  - DECISIONS surface with the forced `skipped:true` file shows the skip note
    (success path); and with a cluster `landedRate:null` shows the "n too low" note.
  - **Failure-path / falsifiable absence check:** with a *normal* clusters file
    (no `skipped`, a cluster with a non-null `landedRate`), the elements
    `decisions-recurring-skipped` and `cluster-rate-hidden-<id>` MUST be **absent**
    (assert via `queryByTestId === null` in the unit test + visual confirm), while
    the rate text renders — i.e. the disclosures don't fire spuriously.
  - PRACTICE surface shows the curator scaffold disclaimer and no affirmative
    "VERIFIED = passed the falsifier" claim.
  - Capture screenshots as proof.
- Docs updated (CHANGELOG, EXPORTER_VERSION, CLAUDE.md, SKILL.md).
- PR opened against **`main`** on a fresh branch off `main`; `/review-loop`
  (PR/code mode) returns `<promise>review-clean</promise>` with a commit-pinned
  verdict comment.

## Risks / notes

- Version-reconcile: `main` may already be at/above 1.10.0 via #113. If a higher
  version landed, bump to the next free slot and note it (per the Step-5 convention
  already recorded in CHANGELOG `[1.10.0]`).
- The skill is LLM-driven instructions, not executable code, so the SKILL.md
  change is a behavior-doc change; the CLI soft-skip is the load-bearing,
  deterministic guarantee that survives whatever the skill does.
- `Date.now()` in the CLI is fine (it's a CLI, not a workflow script); tests
  assert structural fields, not the timestamp.
