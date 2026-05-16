# chat-arch v2 — Instrumented AI Collaboration Loop

**Status:** Feature request. Not yet started.
**Author / requestor:** Bryce Watson (bryceewatson@gmail.com).
**Target branch:** `feature/v2-instrumented-loop`, based on `feature/scan-coverage-upgrades` after #37 + #44 merge into it (so v2 inherits all round-1 + round-2 scan coverage automatically).
**Drafted:** 2026-05-16.

---

## 1. Why this exists

chat-arch as it stands today reads as three or four products in a trench coat — archaeology viewer, corrections-mining pipeline, agentic Q&A surface, scheduled-task console. Each surface is well-built in isolation, but the story is hard to tell to anyone but the author. The data is rich; the front door doesn't lead anywhere.

v2 collapses chat-arch onto a single sharp positioning:

> **chat-arch instruments your AI collaboration. It preserves what Anthropic deletes, mines what you've learned, verifies what Claude actually delivered, and surfaces what matters as a daily brief and as draft blog posts you can ship.**

That sentence sells one product, not four. The four pillars (B + A + F + D below) are *layers of the same stack*, not alternatives.

---

## 2. The stack (one product, four layers)

```
┌────────────────────────────────────────────────────────────────────┐
│  D — Coach              daily/weekly brief, opportunities,         │  surface
│                         blog drafts ready for review               │
├────────────────────────────────────────────────────────────────────┤
│  F — Auditor            did Claude deliver? did upgrades land?     │  verification
│                         every claim grep-verified against evidence │
├────────────────────────────────────────────────────────────────────┤
│  A — Learning loop      extract patterns, propose CLAUDE.md /      │  analysis
│                         skill / agent upgrades, track outcomes     │
├────────────────────────────────────────────────────────────────────┤
│  B — Continuum          capture, preserve, sync across machines;   │  foundation
│                         beat Anthropic's auto-prune on local data  │
├────────────────────────────────────────────────────────────────────┤
│  Embeddings (Ollama, nomic-embed-text)        substrate            │
│  used by topics, similarity, semantic dedup, recurring-correction  │
│  matching, narrative clustering, blog-post cluster scoring         │
└────────────────────────────────────────────────────────────────────┘
```

Each upper layer needs the one below it. B without A is a backup tool. A without F is mining without quality control. F without D has nothing to deliver. Embeddings are the cross-cutting substrate every layer above the foundation depends on.

---

## 3. Stack situation when this work starts

By the time this PR opens, these are merged or in flight and **must not be re-implemented**:

| State | What's there |
|---|---|
| **Already in `main` via prior PRs** | Cowork + host CLI walkers, Cloud import, manifest schema (sessions + projects + topics + narratives), `mine-corrections` skill, `chat-answer` skill (powers `/chat` page), `schedule` skill (cron routines), `loop` skill (interval re-runs), viewer (sessions / projects / topics / narratives / corrections surfaces), analysis sidecars (`projects.json`, `topics.json`, `narratives.json`, `correction-candidates.json`, `corrections.json`, `applied-improvements.json`, `duplicates.exact.json`, `zombies.heuristic.json`) |
| **PR #37 (open, base = `feature/chat-page`)** | Subagent rollup (Cowork + host CLI), `userTextSamples`, Cowork `tokenTotals` from `audit.modelUsage`, `claude-code-sessions/` routed through Cowork pipeline, `userSelectedFolders` / `slashCommands` / `enabledMcpTools` / `errorMessage` exposed inline, narrative-input widening, per-source cache-bust envelope on `EXPORTER_VERSION`, bumped to `0.9.0`. |
| **PR #44 (open, base = `feature/scan-coverage-upgrades`)** | `sessions-index.json` ingestion (recovers pruned sessions back to ~3 months earlier), WSL distro discovery + UNC-path CLI walker, new `transcriptStatus: 'pruned'`, bumped to `0.10.0`. |
| **PR #37's PR #44's base chain** | This v2 work targets `feature/scan-coverage-upgrades` (which transitively includes `feature/chat-page`) and assumes both PRs are merged or near-merged. |

Assume `EXPORTER_VERSION = 0.10.0` is the starting point. v2 work bumps to `1.0.0`.

---

## 4. Cross-cutting prerequisite: embeddings pipeline

Every layer above the foundation needs embeddings. Build this first.

**Provider:** local Ollama with `nomic-embed-text` (768-dim). The viewer already has Ollama-availability detection (`isOllamaAvailable` in `packages/exporter/src/embeddings/ollama.ts`) — reuse, don't replace. Fail-soft when Ollama is down: warn-once and skip, don't block the scan.

**Storage:** new sidecar `apps/standalone/public/chat-arch-data/analysis/embeddings.bin`. Format: little-endian float32 array, prefixed with a `meta.json` mapping sessionId → offset. Incremental: only re-embed sessions whose `sourceMtimeMs` changed since the last embedding run. ~3 KB per session = trivial storage at 10k sessions.

**Embedding input per session:** concatenation of `title`, `summary` (if present), `preview`, all `userTextSamples`, truncated to ~2k chars. Same input shape as `discoverNarratives` widening so signals stay consistent.

**Acceptance:** `pnpm exporter all` produces `embeddings.bin` with one vector per non-pruned session. Topic count for local sessions in `topics.json` goes from 0 to ≥ 10 emergent clusters. `pnpm exporter embed --only-changed` is a fast path that skips unchanged sessions.

---

## 5. Per-layer specs

### Layer B — Continuum (foundation, mostly done)

Scope here is small because the scan walkers already cover Cowork + host CLI + WSL + sessions-index-pruned + Cloud as of PR #44. What's left for v2:

**B.1 Scheduled scanning.** Wire the existing `schedule` skill to run `pnpm exporter all --no-cloud` nightly at 03:00 local. Cloud scan stays manual (depends on user-initiated ZIP upload). New sidecar `analysis/continuum-health.json`:
```json
{
  "lastScanAt": "2026-05-16T03:00:12Z",
  "lastSuccessfulScanAt": "2026-05-16T03:00:12Z",
  "consecutiveSuccesses": 14,
  "sourcesScanned": ["cowork", "cli-direct", "cli-desktop", "cloud"],
  "entriesByStatus": { "ok": 272, "missing": 87, "crashed": 14, "pruned": 86 },
  "newSessionsSinceLast": 8
}
```

**B.2 Capture-rate guardrails.** Per-source warn-once when `transcriptsMissing / total > 0.20` or `crashedCount > 5`. Surfaced in the daily brief.

**B.3 Optional backup target.** Stretch goal. Configurable `chatArch.backup.target` in `.claude/settings.local.json` pointing at a directory; nightly job rsyncs the `chat-arch-data/` tree there. **Skip if scope-pressure.**

**Acceptance:** Schedule routine exists and runs; `continuum-health.json` populates after each scan; viewer's footer renders a single-line status from it.

---

### Layer A — Learning loop (analysis, partially done)

The `mine-corrections` skill + `applied-improvements.json` + recurring-correction detection already exist. v2 adds:

**A.1 Semantic recurring-correction matching.** Currently `recurringPostApplication` is exact-text match. v2: also flag a correction as recurring if its excerpt's embedding is within cosine 0.85 of an already-applied upgrade's excerpt. Use the same embedding cache built in §4.

**A.2 Upgrade outcome tracking.** When the user clicks APPLY on a `ProposedUpgrade`, record not just the application but the **next N sessions** (default 10) in the affected project / using the affected skill. Sidecar `analysis/upgrade-outcomes.json` answers: did the pattern recur post-application? did session-level metrics improve (turns / cost / errorMessage rate)?

**A.3 "Discovery sessions" tagging.** New entry-level field `discoveryScore` (0–1, optional). Computed offline from: token intensity + tool diversity + correction-applied-after + git PR opened from same gitBranch. High score = candidate for blog draft (Layer D ingests this).

**Acceptance:** `corrections.json` patterns include semantically-matched siblings; `upgrade-outcomes.json` exists with before/after measurements per applied upgrade; ≥5 sessions in current corpus carry `discoveryScore > 0.7`.

---

### Layer F — Auditor (verification, mostly new)

Build the verification layer in two passes.

**F.1 Claim extractor.** New module `packages/analysis/src/auditClaims.ts`. Walk every `assistant` message in every transcript, extract spans matching a known set of completion / verification claims:

| Pattern (regex on assistant text) | Claim type |
|---|---|
| `\b(I |I've |Just )?(fixed|resolved|patched|repaired)\b` | `fix-claim` |
| `\b(all|every) tests? pass(ed|ing|es)?\b` | `tests-pass-claim` |
| `\b(verified|confirmed|tested) (that |this )?works\b` | `verification-claim` |
| `\b(added|implemented|wrote) (a |the )?(test|function|module|feature)\b` | `addition-claim` |
| `\bbuild (passes|succeeds|is green)\b` | `build-pass-claim` |
| `\bnothing (else )?to (change|do|update)\b` | `completion-claim` |

Each claim → `{ sessionId, lineNumber, claimType, span, surroundingContext }` written to `analysis/audit-claims.json`.

**F.2 Evidence verifier.** New module `packages/analysis/src/auditEvidence.ts`. For each claim, run a verifier:

| Claim type | Verifier |
|---|---|
| `fix-claim` | Grep transcript forward for an actual file edit (`tool_use: Edit` or `Write`) within next 20 messages. Pass if found; fail if not. |
| `tests-pass-claim` | Grep transcript forward for `Bash` tool_use with `test`/`vitest`/`pytest` in the command, then check the next `tool_result` for non-zero exit indicators. |
| `build-pass-claim` | Same shape: forward grep for `Bash` tool_use with `build`/`tsc`/`compile`, check result. |
| `verification-claim` | Forward grep for a Bash invocation that could plausibly verify (any tool call within next 10 messages). |
| `addition-claim` | Grep for matching `Write` or `Edit` tool_use. |
| `completion-claim` | Grep forward 30 messages for absence of further user pushback ("but X is still broken", "that didn't work"). |

Each claim → outcome `{ pass | fail | inconclusive }` + reason. Sidecar `analysis/audit-results.json`:
```json
{
  "totals": { "pass": 423, "fail": 47, "inconclusive": 89 },
  "results": [
    {
      "sessionId": "...", "lineNumber": 142, "claimType": "tests-pass-claim",
      "outcome": "fail", "reason": "Bash test command exited 1 at line 145",
      "span": "All 234 tests pass.",
      "context": "..."
    }
  ]
}
```

**F.3 Cross-session audit aggregation.** Sidecar `analysis/audit-summary.json` rolls up per-session, per-project, and per-skill audit stats (claim count by type, pass rate, top failures).

**F.4 Tunable thresholds.** All claim patterns + verifier windows live in `packages/analysis/src/auditConfig.ts` so the user can tune without code edits.

**Acceptance:** F detects ≥3 historical examples of overstated completion in current corpus (concrete sessionIds named in the PR description); `audit-results.json` populates; cross-session aggregate identifies which patterns fail most often.

---

### Layer D — Coach (surface, mostly new)

**D.1 Daily brief generator.** New module `packages/exporter/src/brief/dailyBrief.ts`. Pure function: reads `manifest.json` + every analysis sidecar + `audit-results.json` + `upgrade-outcomes.json`, emits a markdown brief to `analysis/briefs/YYYY-MM-DD.md`. Sections (each is empty/omitted when nothing to report — no padding):

```
TODAY · {date}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
► N patterns shifted this week
  • {emergent cluster or trend with delta vs. prior week}

► N upgrades to propose
  • {target file/skill}: "{proposal text}"
    ({why}; F-verified: {audit signal})

► N blog drafts ready for review
  • "{draft title}" (F: X/Y claims verified) → analysis/blog-drafts/{slug}.md

► N audit concerns
  • Session {SID:...} on {date} claimed "{span}" but {evidence reason}.

► Continuum health: {ok/warning} · {N scans today} · {M missed} · backup {current/stale}
```

**D.2 Schedule integration.** New routine via `schedule` skill: run nightly at 04:00 local after the 03:00 scan. Output destination: viewer's "Today" page + optional email (configurable via `.claude/settings.local.json: chatArch.brief.email`).

**D.3 Threshold tuning hooks.** Every section has a threshold knob exposed in `packages/exporter/src/brief/briefConfig.ts`. Empty sections are silent, not padded with low-confidence noise.

**Acceptance:** A brief generates from current corpus; sections populate from real data (not placeholders); empty days produce a brief with only "Continuum health" section.

---

### Layer D extension — Blog draft mode

**Blog.1 Cluster-score-driven candidate selection.** Read sessions with `discoveryScore > 0.7` (from A.3), cluster them by embedding similarity (cosine ≥ 0.78), score each cluster on:
- session count (≥ 2 sessions = candidate)
- narrative arc (sessions span ≥ 3 days; multiple commits/PRs referenced)
- F-verified outcomes (top sessions in cluster have audit pass rate > 80%)
- novelty (cluster doesn't overlap with existing posts on the user's site — fetch and embed `https://brycewatson.com/blog` index for comparison; cache)

Top clusters → `analysis/blog-candidates.json`.

**Blog.2 Draft generation.** For each top candidate, spawn the `chat-answer` skill in **draft mode**: input is the cluster's sessions + a draft prompt template; output is a markdown blog post with inline `[SID:...]` citations to source sessions. Each post lands at `analysis/blog-drafts/{YYYY-MM-DD}-{slug}.md`.

**Blog.3 F-audit of drafts.** Every claim in the draft (regex same as F.1, applied to the draft text) gets evidence-verified against the source sessions cited inline. Drafts with `>80%` F-pass rate get the green checkmark in the daily brief; lower ones still appear but flagged.

**Blog.4 Voice template.** Pull a few of the user's actual posts (3–5 most recent from `brycewatson.com/blog`) as voice samples in the draft prompt. Avoid "generic AI blog post" tone.

**Acceptance:** ≥1 draft generated from current corpus that the user judges publish-worthy after light editing; F-audit catches ≥1 unsupported claim in a draft.

---

### Front-door redesign

**FD.1 New "Today" page** at `apps/standalone/src/pages/index.astro` (replacing the current viewer index as the default landing). Renders the latest daily brief inline + drill-in links to:
- Patterns shifted → `/projects` or `/topics` filtered
- Upgrades to propose → `/corrections` filtered
- Blog drafts → `/blog-drafts/{slug}`
- Audit concerns → new `/audit` mode
- Continuum health → new `/health` mode

**FD.2 Old viewer surfaces stay, demoted.** Sessions list, projects, topics, narratives, corrections — all stay accessible via top-bar links but no longer default. Existing routes preserved; `/` is the only thing that changes.

**FD.3 New modes.**
- `/audit` — paginated `audit-results.json` browser with filter by outcome + claim type + project.
- `/health` — single-page continuum status from `continuum-health.json`.
- `/blog-drafts/{slug}` — renders a draft with the F-audit verdict inline next to each claim.

**FD.4 Style.** Match existing viewer aesthetic (already mature). Use existing `packages/viewer/src/styles.css` tokens; no new design system.

**Acceptance:** `/` renders Today page populated from real analysis sidecars; all five drill-ins navigate to populated surfaces; old viewer surfaces unchanged and accessible.

---

## 6. Out of scope (explicit non-goals)

Do NOT do these in this PR. They are valid future work but expand scope past one-day buildability.

1. **Cloud / community pattern marketplace.** Anonymized aggregate of user corrections shared across users. Real product surface, real privacy work, real moderation. Future PR.
2. **Per-message embeddings.** Embedding every turn separately (vs. one per session). 7-10x storage, marginal payoff at current corpus scale.
3. **Multi-modal embeddings.** Code-diff, screenshot, artifact embedding. Separate infra.
4. **Vector DB infrastructure.** Tantivy / Lucene / SQLite-FTS. Grep + cached embeddings work at this scale.
5. **macOS / Linux native scanning.** Currently the exporter throws on non-Windows. WSL coverage from PR #44 partially addresses this. Full cross-platform = follow-up issue #38.
6. **Operator console for fleet** (positioning E from the strategy discussion). Promising future direction but a different product.
7. **Real-time push notifications.** Daily brief is the only notification surface. No Slack, no Discord, no mobile push.
8. **Sharing / collaboration features.** chat-arch stays single-user.

---

## 7. Acceptance criteria (measurable)

The PR is ready to merge when every row below holds against the current real corpus:

| # | Criterion | How to verify |
|---|---|---|
| 1 | Embeddings populated for all non-pruned sessions | `wc -c chat-arch-data/analysis/embeddings.bin` > 0; size matches session count × 3KB ± 10% |
| 2 | Local-session topics emerge | `jq '.topics \| length' chat-arch-data/analysis/topics.json` ≥ 10 |
| 3 | Semantic dedup finds at least 5 near-duplicate pairs not in `duplicates.exact.json` | `jq '.clusters \| length' chat-arch-data/analysis/duplicates.semantic.json` ≥ 5 |
| 4 | Project auto-attribution coverage improved by ≥ 30% over title-regex baseline | Manifest sessions with `project` field set go from ~11% to ≥ 14% |
| 5 | F catches ≥ 3 specific known overstated-completion examples in corpus | Three sessionIds called out in PR description, each with claim span + verifier reason |
| 6 | F-audit cross-session aggregate distinguishes top-failing claim types | `audit-summary.json` ranks claim types by fail rate |
| 7 | Daily brief generates from real data | `analysis/briefs/2026-05-XX.md` exists; sections populated; F-link to ≥ 1 audit concern |
| 8 | At least one blog draft passes F-audit at ≥ 80% claim-pass rate | `analysis/blog-drafts/*.md` includes one such draft; F-audit verdict inline |
| 9 | Today page renders | `curl http://localhost:4322/` returns 200 + populated brief HTML |
| 10 | Continuum health surface accurate | `continuum-health.json` matches observed scan/source state; viewer footer renders it |
| 11 | No regressions | `pnpm lint && pnpm test && pnpm build` green; all existing viewer routes still work; existing analysis sidecars still populated |
| 12 | `EXPORTER_VERSION` bumped to `1.0.0` + `CHANGELOG.md` entry | Cache-bust trips on next rescan |
| 13 | Manifest size growth is documented | If post-rescan manifest > 2× pre-rescan baseline, note in PR body with explanation |

---

## 8. Orchestration guidance for the implementing session

This is a single-day, single-PR build. The implementing session should:

**8.1 Branch + base.** Branch `feature/v2-instrumented-loop` from `feature/scan-coverage-upgrades` after PR #37 and PR #44 are merged (or rebased onto whatever the latest is). Do **not** branch from `main` — you'd lose all the scan-coverage work.

**8.2 Sub-agent fan-out structure.** The work decomposes into ~10 parallelizable units. Use Plan + Explore agents for upfront mapping, then dispatch implementation agents in waves:

- **Wave 1 (foundation, parallel):**
  - Embeddings pipeline + Ollama client integration
  - Schema additions (`discoveryScore`, audit/embedding-related types)
  - `continuum-health.json` writer + `schedule` skill routine
- **Wave 2 (analysis, parallel — depend on Wave 1):**
  - `topics.json` local-session extension (uses embeddings)
  - `duplicates.semantic.json` (uses embeddings)
  - `upgrade-outcomes.json` writer (extends `mine-corrections`)
  - F-layer claim extractor (`audit-claims.json`)
- **Wave 3 (verification + surface, parallel — depend on Wave 2):**
  - F-layer evidence verifier (`audit-results.json` + `audit-summary.json`)
  - Daily brief generator (`brief/dailyBrief.ts` + schedule routine)
  - Blog candidate selector + draft generator (uses `chat-answer` skill in draft mode)
- **Wave 4 (UI):**
  - Today page + `/audit` + `/health` + `/blog-drafts/{slug}` routes
  - Demote old viewer index (keep route, change default)

**8.3 Adversarial review per wave.** After each wave lands, spawn an adversarial review sub-agent to red-team the changes against the spec. Iterate until clean.

**8.4 Continuous integration test.** Throughout the build, the dev server on `http://localhost:4322` should stay up. After each wave, smoke-test by opening the Today page (will be empty until Wave 3) and checking analysis sidecars exist + parse.

**8.5 Tests required.** Each new module ships with unit tests (vitest, mirror existing test layout). Integration test that runs the full `pnpm exporter all` + verifies all 13 acceptance criteria. Coverage target: every new function ≥ 1 test, every new sidecar ≥ 1 schema-validation test.

**8.6 Existing skills to leverage (do not reimplement):**
- `chat-answer` — drives `/chat` page and powers blog-draft generation (use in draft mode for Blog.2)
- `mine-corrections` — already mines correction patterns; extend, don't replace
- `schedule` — for B.1, B.3, D.2 scheduled jobs
- `loop` — useful if a wave needs polling (e.g., wait for scheduled scan to finish before brief generation)
- Existing `discoverNarratives`, `discoverProjects`, `discoverTopics`, `discoverClusters` in `packages/analysis/src/`

**8.7 Project rules (from `CLAUDE.md`):**
- **Never `git add -A` / `.` / `--all`.** Stage explicit files only.
- **Never stage `apps/standalone/public/chat-arch-data/manifest.json`** (or sibling analysis sidecars). They populate on disk during testing and contain PII.
- **Open a PR; never push to `main` directly.**
- **PR title under 70 chars.**
- **Squash merge default.**
- **Bump `EXPORTER_VERSION` to `1.0.0`** — schema additions are user-visible.
- **CHANGELOG entry required** at `CHANGELOG.md`.

**8.8 Commit cadence within the PR.** One commit per wave-unit (~10–15 commits total). Each commit message describes what + why in 1–2 sentences (no co-author trailer — the harness classifier rejects it).

---

## 9. Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Ollama not running on user's machine during build.** | Detect via existing `isOllamaAvailable`; fail-soft with warn-once; embedding-dependent pipelines emit empty sidecars rather than crash. User starts Ollama, re-runs `pnpm exporter all`, everything fills in. |
| **F-layer too noisy (lots of false-positive "fail" verdicts).** | Default thresholds err on the side of "inconclusive" not "fail". Tune by living with output for a week post-merge. Patterns + windows are config-driven (F.4) so tuning doesn't require code. |
| **Blog drafts read like AI slop.** | Voice template (Blog.4) pulls user's actual posts. F-audit blocks unsupported claims. User reviews before publishing — drafts are never auto-published. Acceptance #8 requires the user to judge ≥1 draft publish-worthy. |
| **Daily brief becomes notification fatigue.** | Empty sections are silent. Threshold tuning per section. Only one notification surface (no Slack/email by default). |
| **Front-door redesign breaks habitual paths.** | Old viewer routes preserved at unchanged URLs. Only `/` changes default. Users can bookmark `/sessions` to keep the old default behavior. |
| **Scope creep mid-build.** | Section 6 is the authoritative non-goals list. Anything not in §5 or §7 gets deferred to a follow-up issue. |
| **Combined PR too large to review.** | Acceptable trade — single-PR full-stack validation is the explicit user preference. Mitigate via: per-wave commits with focused diffs, per-layer integration test, and the spec-doc this is (review against §7 row-by-row). |
| **Manifest size explosion.** | Acceptance #13 forces documentation if growth > 2×. Mitigation if hit: move audit-results/blog-drafts to per-file sidecars instead of inlining. |

---

## 10. Done definition

This PR is done when:

1. Every row in §7 holds.
2. `pnpm lint && pnpm test && pnpm build` green.
3. Dev server boots and the Today page renders against the user's real corpus.
4. The user has personally reviewed at least one auto-generated blog draft.
5. CHANGELOG entry exists. `EXPORTER_VERSION` is `1.0.0`.
6. PR description includes:
   - Measurement table mirroring §7
   - Three sessionIds where F catches overstated completion (acceptance #5)
   - Link to one blog-draft markdown file (acceptance #8)
   - Sample daily brief markdown (acceptance #7)
   - Manifest size before/after (acceptance #13)

---

*End of feature request. Hand this file to a fresh Claude Code session along with the instruction "implement this spec end-to-end on a new branch, in one PR, using orchestrated sub-agent teams for research / implementation / adversarial review / testing." Expect ~6–10 focused sub-agent waves over a single working day.*
