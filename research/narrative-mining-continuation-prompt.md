# Continuation prompt — narrative-mining feature implementation

Paste the body below into a fresh Claude Code session running in `c:\Users\Bryce\Projects\chat-arch`. The prompt is self-contained and assumes zero context from the session that drafted the spec.

---

# Implement chat-arch narrative-mining feature (V1)

## Why you're here

The existing heuristic narrative kernel (`packages/analysis/src/discoverNarratives.ts`) emits at most two narratives per project — one positive-sentiment cluster, one negative-sentiment cluster — with generic titles like `"Recurring win pattern across N sessions"`. The current corpus (1,179 sessions) yields nine narratives total; ShopForge (9 sessions) gets exactly one. Bryce wants LLM-driven per-project narrative synthesis that surfaces actual themes ("ShopForge ships marketplace integrations weekly", "chat-arch recovers from broken-state debugging") instead of mechanical cluster labels.

The spec is pinned (PR #108, `feature/narrative-mining-spec`). Your job: ship the V1 implementation end-to-end in one bundled PR. The pipeline mirrors persona-mining V1 (PR #106) in shape: Stage-1 deterministic candidates + Stage-2 LLM synthesis + sidecar write + index. Falsifier hookup is V1.1 (out of scope).

## Read first

**Spec (load-bearing — read fully before doing anything else):**
- [`research/narrative-mining-spec.md`](research/narrative-mining-spec.md) — V1 spec with decisions pinned (per-project only, on-SCAN as chain step 6, PROJECTS detail surface with LLM cards primary + heuristic collapsed). Includes file-changes table, sidecar shapes, skill template with Stage-1/2a/2b/2c, merge policy with row-classification, concurrency model with CAS, endpoint contracts for `/api/mine-narratives` + `/api/clear-narratives`, test plan, definition of done, decision log, AND a **"Review-loop cap-hit — unresolved items"** section flagging three architectural opens. Read that section before starting — if any of those opens turn into blockers mid-implementation, escalate to Bryce rather than silently pivoting.

**Sibling-feature precedent (the pipeline you're cloning):**
- [`research/persona-mining-spec.md`](research/persona-mining-spec.md) — the V1 spec that drove PR #106.
- [`research/persona-mining-continuation-prompt.md`](research/persona-mining-continuation-prompt.md) — the implementation prompt drafted from persona-mining-spec.md (this file is its analog).
- [`.claude/skills/mine-persona/SKILL.md`](.claude/skills/mine-persona/SKILL.md) — Stage-2 skill template. Build `.claude/skills/mine-narratives/` parallel to it. Read its error-handling + status-file shape + Stage-3 index merge sections — narrative-mining inherits the recovery semantics line-for-line.
- [`apps/standalone/src/pages/api/mine-persona.ts`](apps/standalone/src/pages/api/mine-persona.ts) — NDJSON-streaming endpoint template + classifyOutcome silent-abort detection. `/api/mine-narratives` follows this shape but with the spec's tighter projectId sanitization regex.
- [`apps/standalone/src/pages/api/clear-personas.ts`](apps/standalone/src/pages/api/clear-personas.ts) — selective wipe template. `/api/clear-narratives` follows this shape but with read-modify-write semantics on the shared narratives.json (NOT a unilateral delete — see spec §"/api/clear-narratives endpoint contract").
- [`packages/exporter/src/analysis/personaCandidates.ts`](packages/exporter/src/analysis/personaCandidates.ts) — Stage-1 heuristic extractor template, especially `sampleSessionsStratifiedByRecency`. Narrative-mining inherits the 4-quartile stratified sampling verbatim.

**Code surfaces that change shape:**
- [`packages/analysis/src/discoverNarratives.ts`](packages/analysis/src/discoverNarratives.ts) — existing heuristic kernel. STAYS as the tier-1 fallback. Modification: stamp emitted rows with `attributedTo: 'deterministic'` + `schemaVersion: 1`. Stay PURE (no fs imports) — writer-side migration logic lives in the exporter caller.
- [`packages/schema/src/narrative.ts`](packages/schema/src/narrative.ts) — Narrative type with v1/v2 schemaVersion + `NarrativeAttribution` (4-value union). `validateNarrative` is your pre-write gate; extend the file-level type for `narratives.json` to include optional `thresholds` + `skipped[]`.
- [`packages/analysis/src/narrativeRung.ts`](packages/analysis/src/narrativeRung.ts) — `narrativeTier()` is documented as the "single point of truth" (line 134-136). Extend its signature with `opts?: { attributedTo?: NarrativeAttribution }`; embed the V1 cap inline. NO sibling helper.
- [`packages/analysis/src/thresholds.ts`](packages/analysis/src/thresholds.ts) — new `narrative.*` block placed immediately after the `persona` block and before `appliedRuleWatcher`.
- [`packages/exporter/src/lib/atomicWrite.ts`](packages/exporter/src/lib/atomicWrite.ts) — the canonical primitive (`atomicWriteJson(filePath, content: string)`). USE AS-IS in V1; no retryEbusy extension.
- [`apps/standalone/src/scripts/fullScan.ts`](apps/standalone/src/scripts/fullScan.ts) — chain orchestrator. Add 6th entry to `FULL_SCAN_STEPS`.

## State reconciliation — DO THIS FIRST

Per [`feedback_state_reconciliation`](C:\Users\Bryce\.claude\projects\c--Users-Bryce-Projects-chat-arch\memory\feedback_state_reconciliation.md):

1. `git status` — current branch + uncommitted files. `apps/standalone/public/chat-arch-data/manifest.json` is local PII and should always be unstaged.
2. `gh pr list --state open --json number,title,headRefName` — open PRs.
3. `gh pr view 108 --json state,statusCheckRollup -q '.state + " | " + ((.statusCheckRollup // []) | length | tostring) + " checks"'` — status of the spec PR.

**Expected state when this prompt fires:**
- **If PR #108 (`feature/narrative-mining-spec`) is merged into main** → branch off main: `git switch main && git pull && git switch -c feature/narrative-mining`. The spec at `research/narrative-mining-spec.md` is now in your worktree.
- **If PR #108 is still open** → wait. Do NOT add implementation work to a docs-only PR; the merge is independent of the implementation review process. If Bryce signals "ship anyway against the unmerged spec," branch off `feature/narrative-mining-spec` directly: `git switch feature/narrative-mining-spec && git switch -c feature/narrative-mining-impl`. Note the dependency in your final PR description.

**NEVER** force-push or use `git switch --discard-changes` (per [`feedback_git_switch_discard`](C:\Users\Bryce\.claude\projects\c--Users-Bryce-Projects-chat-arch\memory\feedback_git_switch_discard.md)).

**NEVER** `git add -A` / `.` (per project CLAUDE.md staging discipline). Stage by explicit path.

## Implementation plan — 5 waves with sub-agent fan-out

Per [`feedback_claude_code_paced_prs`](C:\Users\Bryce\.claude\projects\c--Users-Bryce-Projects-chat-arch\memory\feedback_claude_code_paced_prs.md): Claude-Code-paced work bundles into 1-2 PRs with sub-agent fan-out per wave. Ship as ONE PR.

Run waves sequentially. Within a wave, dispatch sub-agents in parallel. Run `pnpm lint && pnpm test && pnpm build` after each wave's exit gate.

### Wave 1 — schema + thresholds + analysis helpers (pure layer)

**Sub-agent A — schema package:**
- Create `packages/schema/src/narrativeCandidates.ts` with `NarrativeBucket`, `NarrativeCandidate`, `NarrativeCandidateProject`, `NarrativeCandidatesFile`, `SkippedRow`, `NarrativeThresholdsSnapshot`, extended `NarrativesFile` (optional `thresholds` + `skipped[]`) per spec §"Sidecar shapes" + §"narrative-candidates.json — Stage 1 intermediate".
- Wire export through `packages/schema/src/index.ts` (add `export * from './narrativeCandidates.js';` alongside personas).
- Run `pnpm --filter @chat-arch/schema test` to confirm new types compile clean.

**Sub-agent B — thresholds:**
- Extend `packages/analysis/src/thresholds.ts` with the new `narrative.*` block sited **immediately after the `persona` block and before `appliedRuleWatcher`**. Fields: `minSessionsForLlm` (20), `maxSessionsForCorpus` (200), `maxLlmUsdPerProject` (0.50), `minPerProject` (3), `maxPerProject` (8), `evidenceMinPerNarrative` (2), `maxCandidatesPerRecencyBucket` (300). NO `candidateBudgetProxy` (unreachable as designed per spec §"What V1 ships"; deferred to V1.1).
- Add THRESHOLDS test coverage for new fields in the existing thresholds test.

**Sub-agent C — analysis pure helpers:**
- Create `packages/analysis/src/normalizeNarrativeRow.ts` exporting `normalizeNarrativeRow(row): Narrative` (defaults missing `attributedTo='deterministic'` / `contradictingCount=0` / `verifiedAt=null`) AND `classifyAttribution(row): 'heuristic' | 'llm' | 'unknown'` per spec §"Row classification" table. Unknown future attribution values → `'unknown'` (caller drops with log, NOT silently coerced).
- Create `packages/analysis/src/normalizeNarrativeRow.test.ts` (co-located per packages/analysis/ convention) — legacy row missing `attributedTo` defaults to deterministic; all 4 known values bucket correctly; unknown future value → `'unknown'`.
- Create `packages/analysis/src/mergeNarrativeFamilies.ts` per spec §"Merge policy" — pinned signature `mergeNarrativeFamilies({ heuristic, existingLlm, incomingLlm?, mode? })`, 6 enumerated edge cases (c/d/f are throw/log-skip per spec).
- Create `packages/analysis/src/mergeNarrativeFamilies.test.ts` with 10-case unit-test matrix per spec §"Test plan".
- Extend `packages/analysis/src/narrativeRung.ts`: extend `narrativeTier()` signature with `opts?: { attributedTo?: NarrativeAttribution }`; cap-active predicate `opts.attributedTo === 'llm-derived'` → clamp tier ≤ 2. **Simple V1 predicate — no `verifiedAt`/`contradicting` exemption clause** (spec §"V1 tier-cap rule").
- Extend `packages/analysis/src/narrativeRung.test.ts` with the V1-cap tests (LLM row never returns tier-3; legacy callers without opts unchanged).
- Re-export `mergeNarrativeFamilies`, `normalizeNarrativeRow`, `classifyAttribution` from `packages/analysis/src/index.ts`.

**Sub-agent D — heuristic stamping:**
- Modify `packages/analysis/src/discoverNarratives.ts` to stamp emitted rows with `attributedTo: 'deterministic'` + `schemaVersion: 1`. Keep the file PURE (no fs imports).
- Update any affected test fixtures.

**Wave 1 exit gate:** `pnpm lint && pnpm test && pnpm build` clean. Baseline test count check: capture `pnpm test` summary; new tests should be additive, no existing tests should regress.

### Wave 2 — Stage-1 exporter extractor + writer-side migration + EXPORTER_VERSION bump

**Sub-agent A — narrativeCandidates Stage-1 extractor:**
- Create `packages/exporter/src/analysis/narrativeCandidates.ts` modeled on `personaCandidates.ts`. Reuse `scoreSentiment` from `@chat-arch/analysis`. Emit per-project candidate evidence pre-bucketed by recency quartile, each candidate carrying `{ sessionId, updatedAt, title, previewExcerpt, summaryExcerpt, sentimentPolarity, sentimentStrength, outcomeMarkers }`. Use the same 4-quartile stratified-by-recency sampling as `sampleSessionsStratifiedByRecency` (inherit from personaCandidates or factor out a shared helper).
- Create `packages/exporter/test/integration/narrativeCandidates.test.ts` — fixture-driven: assert 4 quartile buckets fill from a synthetic session set with known recency; verify outcome-marker extraction; verify `sessionsWithCandidates` count.

**Sub-agent B — exporter writer-side migration:**
- Create `packages/exporter/src/analysis/buildNarrativesFileObject.ts` with pinned signature `buildNarrativesFileObject(known, passthrough?): NarrativesFile` per spec §"File changes". Merge rule: known fields precedence; passthrough non-reserved keys spread in; reserved keys in passthrough dropped with console.warn.
- Co-located `buildNarrativesFileObject.test.ts`.
- Modify `packages/exporter/src/analysis/index.ts`:
  - Insert `narrativeCandidates` call AFTER `buildPersonaCandidatesFile` and BEFORE the `// ---- Meta ----` block (~line 622), passing `enrichedProjects` + `manifest`.
  - Add `narrative-candidates.json` to `meta.tiers.browser.files`.
  - Replace the existing `writeFile(narrativesPath, ...)` call at ~line 312-320 with the migration sequence per spec §"Modified files" exporter row: read existing file as generic object → route rows through `normalizeNarrativeRow` + `classifyAttribution` → call `mergeNarrativeFamilies({ heuristic: narrativesResult.narratives, existingLlm: existingLlmRows, mode: 'full-rewrite' })` → assemble new file via `buildNarrativesFileObject(...)` PRESERVING existing `skipped[]` verbatim + writing fresh `thresholds` snapshot + `_passthrough` for unrecognized top-level keys → `await atomicWriteJson(narrativesPath, JSON.stringify(fileObj, null, 2) + '\n')`.
  - Bump `EXPORTER_VERSION` 1.6.0 → 1.7.0.

**Wave 2 exit gate:** `pnpm lint && pnpm test && pnpm build` clean. Manual: run `pnpm --filter @chat-arch/standalone dev` briefly, hit SCAN, verify `narrative-candidates.json` lands on disk + existing `narratives.json` gets `attributedTo: 'deterministic'` stamps on its heuristic rows.

### Wave 3 — skill + API endpoints + chain integration

**Sub-agent A — mine-narratives skill:**
- Build `.claude/skills/mine-narratives/SKILL.md` modeled on `.claude/skills/mine-persona/SKILL.md`. Implement:
  - Stage 0 setup (read narrative-candidates.json, manifest, existing narratives.json, spec for grounding).
  - Stage 2a per-bucket sub-agents (4 parallel, one per recency quartile) with the exact prompt template from spec.
  - **Sentiment-polarization rule** in the prompts (outcome-majority polarity from supporting sessions; drop on tie) — NEVER emit `sentiment: 'neutral'`.
  - Stage 2b synthesis sub-agent (one per project) with the exact prompt template + 3-8 narrative count limits + `merged: true` flag for collapsed narratives.
  - Stage 2c deterministic post-LLM stamping (attributedTo / verifiedAt / confidence / actionType / schemaVersion / generatedAt) + validateNarrative drop + sessionId-membership check against Stage-1 candidate set + supportingCount ≥ 2 floor check + CAS retry-once on `generatedAt` mismatch.
  - Output target: read existing narratives.json → classify rows → call mergeNarrativeFamilies → buildNarrativesFileObject → JSON.stringify → Bash tool `Write narratives.json.tmp.<requestId>` then `mv narratives.json.tmp.<requestId> narratives.json` (skill-side atomic write via mv).
  - Stage 3 status file write with summary counts.
- Add `.claude/skills/mine-narratives/lib/` helpers if needed for prompt construction (mirror mine-persona's lib pattern).

**Sub-agent B — API endpoints:**
- Create `apps/standalone/src/pages/api/mine-narratives.ts` following `mine-persona.ts` line-for-line BUT with the spec's tighter projectId sanitization: `/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,126}[a-zA-Z0-9])?$/` + manifest-membership check. `REQUIRED_HEADER = 'chat-arch-mine-narratives'`. Implement `NarrativeOutcomeProbe` + `classifyOutcome` per spec — check BOTH status file `status === 'complete'` AND narratives.json `generatedAt >= startedAt`.
- Create `apps/standalone/src/pages/api/clear-narratives.ts` per spec §"/api/clear-narratives endpoint contract": REQUIRED_HEADER = 'chat-arch-clear-narratives'; read-modify-write semantics (NOT unilateral delete); preserve heuristic rows; remove all LLM rows; clear `skipped[]`; preserve `thresholds`; round-trip unrecognized top-level keys; sweep `narrative-status-*.json` AND `narratives.json.tmp.*` orphans; response shape `{ ok, removedNarratives, removedStatusFiles }`.

**Sub-agent C — chain integration:**
- Update `apps/standalone/src/scripts/fullScan.ts`: append 6th entry to `FULL_SCAN_STEPS` `{ id: 'narratives', label: 'mine narratives', url: '/api/mine-narratives', header: 'chat-arch-mine-narratives' }`.
- Update `apps/standalone/test/scripts/fullScan.test.ts`: step count → 6, header-pinning entry, all chain-semantics tests run as 6-step, ordering assertion (mock step 5 returning a long NDJSON stream; assert step 6 doesn't POST until step 5 closes).

**Sub-agent D — API tests:**
- Create `apps/standalone/test/pages/api/mine-narratives.api.test.ts` — CSRF rejection, projectId sanitization (leading `-` rejected, trailing `_` rejected, special chars rejected, unknown projectId rejected with manifest fixture), inFlight 409, `NarrativeOutcomeProbe` silent-abort.
- Create `apps/standalone/test/pages/api/clear-narratives.test.ts` — heuristic rows preserved, LLM rows removed, `deterministic-with-prior` rows preserved, `falsifier-verified` rows removed, unrecognized top-level fields preserved (round-trip with synthetic `futureField`), `narrative-candidates.json` untouched, status files swept, CSRF 403, inFlight 409, split counts.

**Wave 3 exit gate:** lint + test + build clean. Manual: SCAN button on TODAY fires 6 POSTs in dev server log → `/api/rescan` → `/api/mine-corrections` → `/api/curate` → `/api/falsify` → `/api/mine-persona` → `/api/mine-narratives`.

### Wave 4 — viewer two-tier UI

**Sub-agent A — ProjectsMode rewrite:**
- Modify `packages/viewer/src/components/modes/ProjectsMode.tsx`:
  - Filter narratives into LLM-derived (`attributedTo === 'llm-derived'` after `normalizeNarrativeRow`) and heuristic.
  - Render LLM cards as primary, sorted by `narrativeTier(confidence, supporting, contradicting, { attributedTo })` desc, then `confidence` desc, then `supportingCount` desc, then `generatedAt` desc.
  - Each LLM card: title + body excerpt + provenance triple (collapsed-by-default) + evidence pills with `[SID:...]` click-through to `/sessions#session/<sid>` (existing hash router) + tier badge (V1: badges show tier-1/tier-2; tier-3 should never render for LLM rows due to V1 cap — assertion-worth in tests).
  - Heuristic cards inside a `<details>` collapsed disclosure labeled "Raw sentiment clusters (deterministic)".
  - Per-project "REGEN NARRATIVES" button (POSTs `/api/mine-narratives` with `{ projectId }`).
  - Handle skipped-row case: project with `synthesis-failed` + zero LLM rows shows a one-line "LLM found no durable narratives this run; raw clusters still available" hint, NOT both card-render AND skip-listing.
- Update `packages/viewer/src/components/modes/ProjectsMode.test.tsx`: fixture with 2 heuristic + 3 LLM narratives — assert order, tier badges (no tier-3 on LLM rows), V1-cap behavior, legacy-row-missing-attributedTo handling, skipped-row UI.

**Wave 4 exit gate:** lint + test + build clean. Manual: chat-arch project's detail page renders LLM narrative cards primary; heuristic cards inside collapsed disclosure; REGEN button works per-project (no other project's LLM rows change).

### Wave 5 — docs + final polish

Single agent (no fan-out):

- Update `CHANGELOG.md` with `[1.7.0]` entry covering narrative-mining feature + calibration notes for placeholder thresholds.
- Update `CLAUDE.md` "Data on disk" section: new entry for `analysis/narrative-candidates.json` + the two additive optional top-level fields (`thresholds`, `skipped[]`) on `narratives.json` (NO file-level schemaVersion bump). New entry under "Shape of the workspace" for `.claude/skills/mine-narratives/`.
- Update `.gitignore`: explicit `analysis/narrative-candidates.json` line for auditable documentation (already covered by wildcard).
- Update CLAUDE.md "fresh-contributor hygiene check" section if narrative-mining changes any of the answers.

**Wave 5 exit gate:** lint + test + build clean. Full manual end-to-end per spec §"Manual end-to-end" bullet.

## Review loop — adversarial subagent teams until clean

After Wave 5 lands locally, BEFORE opening the PR, run the following review loop. This is in addition to the global auto-`/review-loop` Stop hook (which will also fire); the explicit loop here gives you adversarial-team review at implementation time rather than waiting for the post-Stop trigger.

### Iter N review pass

Dispatch **5 review-lens sub-agents in parallel** via the Agent tool (subagent_type: general-purpose, all in one message for true concurrency). The reviewers do NOT see prior iters' findings — each iter is fresh.

Per-lens brief:

1. **Simplicity** — over-implementation, infrastructure beyond what V1 needs, parallel/duplicate systems. Cross-reference against `research/narrative-mining-spec.md`'s §"Review-loop cap-hit" — the two-sidecar alternative is a known open; if the implementation surfaces the kind of bug that pivot would have prevented, flag it.
2. **Design-coherence** — codebase conventions, package boundary discipline (analysis = pure; exporter = I/O; schema = types), persona-mining V1 precedent, threshold placement, test layout.
3. **Adversarial** — what breaks: race conditions, validateNarrative throw paths uncovered, CAS retry edge cases, projectId allow-list bypasses, atomicWriteJson signature misuse, sessionId-hallucination paths, write-tool interruption corruption.
4. **Ship-readiness** — does CI pass? Are tests genuinely exercising the surface or rubber-stamping? Is the PR description complete? Is the test plan from the spec fully checked off? Did any acknowledged V1 limitations slip into the PR body? Lint warning ceiling unchanged?
5. **Statistical-rigor** — confidence math arithmetic correct in code? Tier-cap predicate matches the simplified V1 form? Sampling stratification preserved? Min-evidence enforced at BOTH emission time AND Stage 2c?

Strict FINDING format per lens (separated by blank lines):

```
FINDING <n>: <one-line title>
SEVERITY: load-bearing | minor | speculative
SECTION: <file:line range or test name>
CLAIM: <what's wrong>
EVIDENCE: <verbatim quote from code, diff, or test output>
SUGGESTED FIX: <concrete change>
```

End each lens with `TOTAL FINDINGS: <count>`.

### Iter N execution-grounded pass

In parallel with the 5 lens-agents, dispatch ONE execution-grounded runner agent that:
- Runs `pnpm lint && pnpm test && pnpm build` and captures any failures.
- Runs the manual end-to-end checklist from spec §"Manual end-to-end" by spawning a `pnpm dev` in the background, scripting the SCAN button via curl (with the CSRF headers), and asserting the expected on-disk artifacts.
- Reports findings in the same FINDING format. **Execution findings bypass falsifier filtering** — they're verified by the act of running.

### Iter N falsifier pass

After all 5 lens-agents + execution agent return, dispatch ONE falsifier agent (general-purpose, separate message) that for each load-bearing finding from the lens-agents reads the cited file/diff and reports VERIFIED / UNVERIFIED / UNAVAILABLE. Drop UNVERIFIED findings. Execution-runner findings skip the falsifier (they're already grounded).

### Iter N improvement pass

For each VERIFIED load-bearing finding + every execution finding: address in code. Convergent-minor findings (≥2 lenses flagging the same issue): also address. Single-reviewer minors and speculative findings: ack in the PR description's "known limitations" section as deferred to V1.1, do NOT address.

### Loop termination

Repeat iter N+1 — re-dispatch the 5 lens-agents + execution runner + falsifier — until:
- All VERIFIED load-bearing findings from iter N are addressed in iter N+1
- Iter N+1 returns **zero new VERIFIED load-bearing findings AND zero execution failures**

**Cap:** 5 iterations OR oscillation detection (a finding fixed in iter K reappears in iter K+1). On cap-hit, STOP and surface the unresolved items in the PR description's "known limitations" section as "implementation calibration needed — caught at review-loop cap." Do NOT silently ship.

### Cost discipline

The review loop runs on plan-usage (`claude -p` subprocesses), not Anthropic API spend. Each iter is roughly 6 sub-agent dispatches (5 lenses + 1 execution + 1 falsifier in separate message). Stop the loop if Bryce signals cost concern, OR if iter count crosses 5 with no convergence.

## Test gates (per project CLAUDE.md)

Before opening the PR:
- `pnpm lint` — clean (max 1 pre-existing warning in `apply-correction.ts`; no new warnings).
- `pnpm test` — clean (baseline pass count maintained — check `main`'s count immediately before opening; persona-mining shipped on 2154+).
- `pnpm build` — clean.
- Manual: SCAN on TODAY → 6 POSTs in dev server log: `/api/rescan` → `/api/mine-corrections` → `/api/curate` → `/api/falsify` → `/api/mine-persona` → `/api/mine-narratives`.
- Manual: `analysis/narratives.json` contains at least 1 `attributedTo: 'llm-derived'` row for the chat-arch project after SCAN, with provenance triple populated + ≥2 evidence pills.
- Manual: PROJECTS detail page renders the two-tier display (LLM cards primary, heuristic collapsed).
- Manual: REGEN NARRATIVES button per-project works (and doesn't change other projects' LLM rows).
- Manual: CLEAR NARRATIVES (via the dev-only affordance) wipes only LLM rows.

If the auto-generated chat-arch narrative quality is visibly low-signal (e.g., all 3 LLM narratives are obvious restatements of the heuristic clusters), surface in the PR description as a known V1 calibration limitation — do NOT block on perfecting the synthesis prompt (calibration is in §"Calibration plan").

## Project conventions (reminders, per chat-arch CLAUDE.md)

**Staging:**
- NEVER `git add -A` / `.` — stage by explicit path.
- `apps/standalone/public/chat-arch-data/manifest.json` is local PII — leave unstaged.
- `analysis/narratives.json` may contain locally-generated LLM rows with PII — leave unstaged (the wildcard gitignore covers it).

**Git workflow:**
- Branch off main + PR, never push to main.
- `gh pr create` after `git push -u origin feature/narrative-mining`.
- Squash-merge default.
- Bryce merges his own PRs unless he says otherwise — open the PR, surface CI status, do NOT merge.

**Out of scope (V1) — do NOT do these:**
- Cross-project composite narrative
- NARRATIVES sidebar entry
- SQLite `narratives` table mirror (V1 writes sidecar only)
- Falsifier extension to verify narrative evidence (V1.1)
- Curator-feed surfacing of tier-2+ LLM narratives (V1.1)
- Contrary-evidence finder (V1.1 — this is what lifts the V1 tier-cap)
- Narrative-drift detection
- Hosted-demo narrative generation
- Replacing the heuristic kernel (even at V2)
- `candidateBudgetProxy` threshold (unreachable as designed; V1.1)
- atomicWriteJson EBUSY retry extension (V1.1)
- `/api/mine-persona` projectId sanitization hardening (sibling task, not narrative-mining V1)
- Hand-authored canonical narrative exemplar (analog to bryce.md)

Each of the above is listed in spec §"Out of scope (V1)". If you find yourself wanting to do any of them, stop and surface as a follow-up note in the PR description.

## When done

1. Run final `pnpm lint && pnpm test && pnpm build` on a clean state — confirm all green.
2. Run final manual end-to-end checklist + capture screenshots/log excerpts if Bryce's PR review will benefit.
3. Open PR via `gh pr create` with title `feat(narrative-mining): per-project narrative auto-generation as SCAN chain step 6`.
4. PR description: summary, decisions pinned (cite spec PR #108), waves shipped, review-loop iter count + load-bearing findings closed per iter, test plan checked off, known V1 limitations (LLM rows tier-capped at 2; contradictingCount always 0; no SQLite mirror; no falsifier hookup; calibration TBD), cap-hit follow-ups if any.
5. Surface CI status. Do NOT merge.
6. Report back with the PR URL.

## Estimated complexity

~18-28 files, mostly new, ~1800-2800 LOC including tests. Single bundled PR. Larger than persona-mining (PR #106 was ~15-25 files) because of the heuristic-LLM merge policy + ProjectsMode two-tier UI change.

Review-loop typically converges in 3-5 iterations. Plan-usage cost; no Anthropic API key needed.

If any wave's exit gate fails repeatedly OR the review loop hits its 5-iter cap without convergence, STOP and ask Bryce — do not silently scope-cut, do not silently ship unresolved load-bearing findings.
