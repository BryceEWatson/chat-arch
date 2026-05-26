# Narrative mining — V1 spec

**Status:** spec only — no implementation. Awaiting Bryce's "act on the plan" before any code lands.

**Origin:** the existing heuristic narrative kernel (`packages/analysis/src/discoverNarratives.ts`) emits at most two narratives per project — one positive-sentiment cluster, one negative-sentiment cluster — with generic mechanical titles (`"Recurring win pattern across N sessions"`). The current corpus (1,179 sessions) yields nine narratives total; ShopForge (nine sessions) gets exactly one. Bryce wants LLM-driven per-project narrative synthesis that surfaces actual themes ("ShopForge ships marketplace integrations weekly", "chat-arch recovers from broken-state debugging") rather than mechanical cluster labels. This pipeline mirrors persona-mining V1 (PR #106) line-for-line in shape: Stage 1 deterministic candidates, Stage 2 LLM synthesis, sidecar write + index, optional Stage 3 falsifier hookup later.

**Decisions pinned (per design conversation 2026-05-25):**

1. **Scope:** per-project narratives only — no cross-project composite in V1.
2. **Trigger:** on SCAN, as chain step 6 (after `/mine-persona`).
3. **UI surface:** render in the existing PROJECTS detail surface — LLM-derived narrative cards take the primary slot; heuristic narratives demote to a collapsed "raw clusters" panel. No new sidebar entry in V1.
4. **Heuristic kernel fate:** **keep** + add LLM stage. The deterministic kernel stays as tier-1 fallback (always-runs, no LLM cost, useful when corpus or budget is below the LLM gate). LLM-derived narratives land at tier-2/tier-3 with provenance and confidence. Both row families coexist in `narratives.json` distinguished by `attributedTo`.
5. **Storage destination:** JSON sidecar (`analysis/narratives.json`) as primary write target — adds two additive optional top-level fields (`thresholds` snapshot, `skipped[]`); NO file-level schemaVersion bump (existing readers ignore unknown keys; `EXPORTER_VERSION` 1.6.0 → 1.7.0 is the cutover marker). Individual rows can be either `schemaVersion: 1` (legacy heuristic) or `schemaVersion: 2` (LLM-derived with full provenance). The SQLite `narratives` table mirror is **deferred to V1.1** — V1 reads + writes sidecar only, matching the persona-mining V1 precedent.
6. **Falsifier integration:** **deferred to V1.1.** Stage-2 emits `attributedTo: 'llm-derived'` so the existing `/falsify` skill can pick up these narratives via the same evidence-chain verification path it already uses for findings — a follow-up PR wires the call, not this spec.

This doc covers what ships in V1, not the eventual maturity path. Cross-project composite, narrative-drift detection, SQLite mirror, falsifier integration, and curator-feed surfacing of tier-2+ narratives are all in the [Out of scope (V1)] section.

---

## What V1 ships

Per project with ≥ `THRESHOLDS.narrative.minSessionsForLlm` (default 20) sessions in the corpus:

- 3-8 LLM-derived narratives per project at `analysis/narratives.json` with `attributedTo: 'llm-derived'`, `schemaVersion: 2`, populated provenance (intent/observation/inference), confidence-ladder participation
- Existing heuristic narratives (≤2 per project) preserved alongside, `attributedTo: 'deterministic'`, `schemaVersion: 1`
- A new Stage-1 sidecar `analysis/narrative-candidates.json` (deterministic per-project candidate evidence pool — the input to Stage 2)
- A new per-run progress file `analysis/narrative-status-${requestId}.json`
- PROJECTS detail surface renders the LLM narratives as primary cards; heuristic narratives collapse into a "raw clusters" reveal panel
- A new `/api/clear-narratives` endpoint wipes the LLM additions + status files but preserves heuristic narratives (`/api/clear` continues to wipe everything via `wipeAll`)

Projects below the session threshold get `attributedTo: 'deterministic'` rows only (heuristic continues to run as before). Per-project LLM-spend is bounded by `maxLlmUsdPerProject` ($0.50 default) — projects whose first Stage-2 sub-agent already lands over this cap get a `budget-exceeded` skip-row. V1 does NOT ship the `candidateBudgetProxy` gate: the spec's iter-4 audit observed that with `maxSessionsForCorpus=200` capping each project's candidates at ≤200, a proxy at 1200 is unreachable as designed. V1.1 may re-introduce a per-bucket-candidate-count gate once `maxSessionsForCorpus` is also being tuned.

---

## File changes

### New files

| Path | Purpose |
|---|---|
| `.claude/skills/mine-narratives/SKILL.md` | Skill driving the LLM synthesis stage |
| `apps/standalone/src/pages/api/mine-narratives.ts` | NDJSON-streaming endpoint, follows `mine-persona.ts` template line-for-line |
| `apps/standalone/src/pages/api/clear-narratives.ts` | Selective wipe endpoint (LLM rows + status files only — heuristic preserved) |
| `packages/exporter/src/analysis/narrativeCandidates.ts` | Per-project deterministic candidate extractor (writes `narrative-candidates.json`) |
| `packages/exporter/test/integration/narrativeCandidates.test.ts` | Integration coverage |
| `packages/analysis/src/mergeNarrativeFamilies.ts` | Heuristic-vs-LLM merge helper consumed by exporter (rescan write) and skill (Stage 2 merge-back). Contract pinned in §"Merge policy" below. |
| `packages/analysis/src/mergeNarrativeFamilies.test.ts` | Unit tests for the merge helper. Co-located per `packages/analysis/`'s test convention (cf. `narrativeRung.test.ts`, `discoverNarratives.test.ts`). |

### Modified files

| Path | Change |
|---|---|
| `apps/standalone/src/scripts/fullScan.ts` | Add 6th entry to `FULL_SCAN_STEPS` for `/api/mine-narratives` (header `chat-arch-mine-narratives`) |
| `apps/standalone/test/scripts/fullScan.test.ts` | Update step count + header-pinning assertions to 6 |
| `apps/standalone/src/pages/api/clear.ts` | No change required. `wipeAll` already recursively removes everything under `chat-arch-data/` except `.gitkeep`, which covers all new sidecars + status files. The new sidecars are picked up automatically. (Row retained here as a NO-OP audit trail; implementer should confirm by re-reading `clearDataDir.ts:wipeAll` before deleting the file from their wave plan.) |
| `packages/analysis/src/thresholds.ts` | New `narrative.*` block, sited **immediately after the `persona` block and before `appliedRuleWatcher`** (matches sibling per-project-LLM-mining placement; keeps `persona` + `appliedRuleWatcher` from being adjacent — acceptable per existing block-ordering, but pinned here to avoid implementer ambiguity). Fields: `minSessionsForLlm` (default 20), `maxSessionsForCorpus` (default 200), `maxLlmUsdPerProject` (default 0.50), `minPerProject`/`maxPerProject` (3/8), `evidenceMinPerNarrative` (default 2), `maxCandidatesPerRecencyBucket` (default 300). **`candidateBudgetProxy` is NOT included in V1** — iter-4 audit showed it is unreachable with `maxSessionsForCorpus=200` × 1 candidate/session. V1.1 may add it once empirical per-project candidate counts justify the gate. **Field-name note:** persona's `maxCandidatesPerBucket` caps SEMANTIC buckets (6 × 40); narrative's analog caps RECENCY buckets (4 × 300). Renamed `…PerRecencyBucket` so the axis-change is greppable. |
| `packages/analysis/src/discoverNarratives.ts` | Stamp emitted rows with `attributedTo: 'deterministic'` + `schemaVersion: 1` (unchanged otherwise — heuristic policy stays as-is). The kernel remains PURE (no fs imports); writer-side migration logic lives in the exporter caller below. |
| `packages/analysis/src/narrativeRung.ts` | **Extend `narrativeTier()` signature** to accept additional row-metadata: `narrativeTier(confidence, supporting, contradicting, opts?: { attributedTo?: NarrativeAttribution })`. Cap-active predicate (simplified V1): `opts.attributedTo === 'llm-derived'` → clamp returned tier to `≤ 2`. No `verifiedAt`/`contradicting` exemption clause in V1 because (a) V1's hardcoded `contradicting=0` makes any conditional exemption inactive anyway, and (b) V1.1 will rip the cap out entirely when the contrary-evidence finder lands — wiring a dead exemption now buys nothing. This preserves `narrativeTier` as the "single point of truth" (per the existing `narrativeRung.ts:134-136` docstring); no sibling helper. Cap REMOVED in V1.1. |
| `packages/analysis/src/index.ts` | Re-export `mergeNarrativeFamilies` + the extended `narrativeTier` signature. |
| `packages/exporter/src/analysis/index.ts` (Stage-1 wiring) | Run `narrativeCandidates` AFTER `buildPersonaCandidatesFile` and BEFORE the `// ---- Meta ----` block (pinned location ≈ `index.ts:622`), passing the same `enrichedProjects` + `manifest` the persona builder uses. Add `narrative-candidates.json` to `meta.tiers.browser.files`. |
| `packages/exporter/src/analysis/index.ts` (writer-side migration) | Replace the existing `writeFile(narrativesPath, …)` call at `index.ts:312-320` with: read existing on-disk `narratives.json` as a generic object → route every row through `normalizeNarrativeRow` then `classifyAttribution` → call `mergeNarrativeFamilies({ heuristic: narrativesResult.narratives, existingLlm: existingLlmRows, mode: 'full-rewrite' })` → assemble new file via `buildNarrativesFileObject({ generatedAt: now, exporterVersion: '1.7.0', thresholds: <derived from THRESHOLDS.narrative.*>, narratives: merged, skipped: <preserve existing-file's skipped[] verbatim>, _passthrough: <existing-file's unrecognized top-level keys> })` → `await atomicWriteJson(narrativesPath, JSON.stringify(fileObj, null, 2) + '\n')`. **Ownership rules:** the exporter writes `thresholds` snapshot (it knows the runtime thresholds) and PRESERVES `skipped[]` verbatim from disk (the skill owns `skipped[]` because LLM-stage skip-reasons are the only kind that exist; the exporter has no LLM state to update). Forward-compat: unrecognized top-level keys round-trip via `_passthrough`. |
| `packages/exporter/src/analysis/index.ts` | Bump `EXPORTER_VERSION` 1.6.0 → 1.7.0 (new sidecar family + optional `thresholds` + `skipped` blocks on `narratives.json`). |
| `packages/exporter/src/lib/atomicWrite.ts` (existing — used as-is) | The exporter writer uses the **existing** `atomicWriteJson(filePath, content: string)` helper unchanged. **Call signature pinned:** `await atomicWriteJson(narrativesPath, JSON.stringify(buildNarrativesFileObject({ generatedAt: now, exporterVersion, thresholds, narratives: merged, skipped }), null, 2) + '\n');` — the helper takes a serialized string, NOT an object. The `buildNarrativesFileObject` composer (new helper, listed below) builds the file-level shape from the merged rows + side-band fields. **No retryEbusy extension in V1** — if Windows EBUSY surfaces empirically on the first 10 runs, add the retry under a `[1.7.x]` calibration follow-up. **Skill-side write atomicity:** the skill (a `claude -p` subprocess) writes via the Bash tool with the same tmp+rename pattern (`Write tmp; mv tmp final`) — see §"Skill template" Stage 2c. Update the §"Test plan" `mine-narratives` integration test to allow `.tmp.<requestId>.json` files during the write window (forbidding only LEFTOVER ones at the end of the run). |
| `packages/analysis/src/normalizeNarrativeRow.ts` (new) | Exports `normalizeNarrativeRow(row): Narrative` (defaults `attributedTo='deterministic'`, `contradictingCount=0`, `verifiedAt=null`) AND `classifyAttribution(row): 'heuristic' \| 'llm' \| 'unknown'` (maps the 4-value NarrativeAttribution + missing → buckets; unknown future values fall to `'unknown'` and the caller drops them with a log warning). Re-exported from `packages/analysis/src/index.ts` alongside `mergeNarrativeFamilies`. |
| `packages/analysis/src/normalizeNarrativeRow.test.ts` (new) | Co-located unit tests: legacy row missing `attributedTo` → defaulted to `'deterministic'`; all four known values bucket correctly; unknown future value → `'unknown'` (NOT silently coerced to `'heuristic'`). |
| `packages/exporter/src/analysis/buildNarrativesFileObject.ts` (new) | Pure file-object composer. **Pinned signature:** `buildNarrativesFileObject(known: { generatedAt: number; exporterVersion: string; thresholds: NarrativeThresholdsSnapshot; narratives: readonly Narrative[]; skipped: readonly SkippedRow[]; }, passthrough?: Record<string, unknown>): NarrativesFile`. **Merge rule:** known fields take precedence; `passthrough` entries are spread into the output for any key NOT in the reserved set `{generatedAt, exporterVersion, thresholds, narratives, skipped}`. Reserved-key entries in `passthrough` are dropped with a `console.warn` (the file-level known-key contract takes precedence over forward-compat passthrough). Both writers (exporter + skill) use this composer so the file-level shape is single-sourced. Co-located test asserts: known fields ordered correctly; unknown passthrough keys round-trip; reserved keys in passthrough dropped with warning. |
| `packages/schema/src/narrative.ts` | Extend the file-level type for `narratives.json` to include optional `thresholds` snapshot + optional `skipped[]` field (`{ projectId, status, reason }`). Keep all narrative ROW types unchanged — schemaVersion stays 1 \| 2 per Rev3-B. |
| `packages/schema/src/narrativeCandidates.ts` (new) | `NarrativeCandidatesFile`, `NarrativeCandidateProject`, `NarrativeCandidate` types. Mirrors `personas.ts`'s single-file shape — co-locate all narrative-mining schema types here (Candidates + Skipped + IndexFile-fields). |
| `packages/schema/src/index.ts` | Add `export * from './narrativeCandidates.js';` next to the existing `export * from './personas.js';` (line 23). Without the barrel re-export, `import { NarrativeCandidatesFile } from '@chat-arch/schema'` fails at consumer sites. |
| `packages/viewer/src/components/modes/ProjectsMode.tsx` | Render `attributedTo === 'llm-derived'` narratives as primary cards; collapse heuristic rows into a "raw clusters" reveal panel below |
| `packages/viewer/src/components/modes/ProjectsMode.test.tsx` | Update fixtures to assert two-tier rendering |
| `CHANGELOG.md` | `[1.7.0]` entry |
| `CLAUDE.md` | New entry under "Data on disk" describing the narrative-candidates sidecar + the two additive optional top-level fields (`thresholds`, `skipped[]`) on `narratives.json` (NO file-level schemaVersion bump — `EXPORTER_VERSION` 1.6.0 → 1.7.0 is the cutover marker). New entry under "Shape of the workspace" for the `mine-narratives` skill. |

### Files explicitly NOT modified (V1 scope boundary)

| Path | Why preserved |
|---|---|
| `packages/exporter/src/db/sdk/narratives.ts` | SQLite mirror is V1.1 — V1 writes sidecar only |
| `packages/exporter/src/db/sdk/narrativeEvidence.ts` | Same — V1.1 |
| `.claude/skills/falsify/SKILL.md` | Falsifier hookup is V1.1 — V1 emits `attributedTo: 'llm-derived'` so the V1.1 hookup is config, not code |

---

## Sidecar shapes

### `analysis/narratives.json` — file shape (V1 additive bump)

V1 adds two **optional** top-level fields (`thresholds` snapshot + `skipped[]`) without bumping any file-level schemaVersion — existing readers ignore unknown top-level keys, and the row-level `schemaVersion` (already 1 \| 2 per Rev3-B) is the load-bearing version axis. `EXPORTER_VERSION` advancing from 1.6.0 → 1.7.0 is the auditable cutover.

```jsonc
{
  "generatedAt": 1716673200000,
  "exporterVersion": "1.7.0",
  "thresholds": {              // NEW — optional snapshot for disclosure (readers ignore if absent)
    "minSessionsForLlm": 20,
    "maxSessionsForCorpus": 200,
    "minPerProject": 3,
    "maxPerProject": 8,
    "evidenceMinPerNarrative": 2,
    "maxLlmUsdPerProject": 0.50,
  },
  "narratives": [
    {
      "id": "narr_proj_chat-arch_positive_8mtfp6",
      "projectId": "proj_chat-arch",
      "sessionIds": ["..."],
      "sentiment": "positive",
      "title": "Recurring win pattern across 15 sessions",
      "body": "Sessions in this cluster show...",
      "evidence": [{ "sessionId": "...", "excerpt": "..." }],
      "generatedAt": "2026-05-25T23:26:28.721Z",
      "actionType": "encode-as-pattern",
      "schemaVersion": 1,
      "attributedTo": "deterministic"      // NEW — stamped by discoverNarratives on next rescan
    },
    {
      "id": "narr_llm_proj_chat-arch_<hash>",
      "projectId": "proj_chat-arch",
      "sessionIds": ["..."],
      "sentiment": "positive",
      "title": "Reflexive loop discipline closes the ratchet",
      "body": "Across 12 sessions the user converges on...",
      "evidence": [
        { "sessionId": "...", "anchor": "step-by-step", "excerpt": "..." },
        { "sessionId": "...", "anchor": "ratchet-cosine", "excerpt": "..." }
      ],
      "generatedAt": "2026-05-25T23:26:28.721Z",
      "actionType": "encode-as-pattern",
      "schemaVersion": 2,
      "attributedTo": "llm-derived",
      "provenance": {
        "intent": "Identify durable workflow patterns the user re-invokes across phases",
        "observation": "12 of 14 sessions in this project explicitly invoke /review-loop or describe iteration-until-clean discipline",
        "inference": "review-loop discipline is a durable, project-defining methodology, not a one-off"
      },
      // confidence = supporting/(supporting+contradicting+defaultPrior=2) → 12/(12+0+2) = 0.857
      // V1 always emits contradictingCount=0 (no contrary-evidence finder until V1.1).
      // narrativeTier() then clamps tier to ≤ 2 (the V1 cap) regardless of computed confidence — see §"V1 tier-cap rule".
      "confidence": 0.857,
      "supportingCount": 12,
      "contradictingCount": 0,
      "verifiedAt": null
    }
  ],
  "skipped": [                 // NEW — optional. Per-project skip rows for projects that didn't ship narratives this run.
    {
      "projectId": "proj_shopforge",
      "status": "insufficient-corpus",   // sessionsTotal < minSessionsForLlm
      "reason": "9 sessions < 20 minimum"
    },
    {
      "projectId": "proj_some-huge-monorepo",
      "status": "budget-exceeded",       // first Stage-2 dispatch exceeded maxLlmUsdPerProject
      "reason": "first sub-agent spent $0.61 > $0.50 cap; remaining sub-agents skipped"
    },
    {
      "projectId": "proj_no-themes",
      "status": "no-durable-themes",     // synthesis returned zero narratives
      "reason": "all 4 buckets returned bucketEmpty: true"
    },
    {
      "projectId": "proj_synth-failed",
      "status": "synthesis-failed",      // malformed-JSON retry exhausted
      "reason": "synthesis sub-agent returned malformed JSON after 1 retry; deterministic rows preserved"
    }
  ]
}
```

**Enumerated `skipped[].status` values:** `insufficient-corpus` \| `budget-exceeded` \| `no-durable-themes` \| `synthesis-failed` \| `concurrent-rescan-aborted`. Below-threshold projects continue to receive `attributedTo: 'deterministic'` rows from the heuristic kernel — the skip row is purely about LLM enrichment status.

**Id namespace separation.** Heuristic ids stay at `narr_<projectId>_<polarity>_<hash>`. LLM ids gain a `narr_llm_` prefix so the two row families never collide.

### Merge policy

The `mergeNarrativeFamilies` helper has the following pinned contract:

```ts
interface MergeInputs {
  /** Newly-emitted heuristic rows (always tagged `attributedTo: 'deterministic'`). */
  heuristic: readonly Narrative[];
  /** LLM rows already on disk (read by the caller from the existing narratives.json). */
  existingLlm: readonly Narrative[];
  /** New LLM rows being introduced this call (empty when called from the rescan path). */
  incomingLlm?: readonly Narrative[];
  /**
   * Scope of the call:
   *   - 'full-rewrite' (default): every projectId's LLM rows in `existingLlm` are preserved
   *     except those that appear in `incomingLlm` — those get replaced wholesale.
   *   - { projectId }: only this project's LLM rows are eligible for replacement; all
   *     other projects' LLM rows are preserved untouched.
   */
  mode?: 'full-rewrite' | { projectId: string };
}

function mergeNarrativeFamilies(inputs: MergeInputs): readonly Narrative[];
```

Edge cases pinned:

- (a) empty `heuristic` → result contains only `existingLlm` ∪ `incomingLlm`.
- (b) empty `existingLlm` + empty `incomingLlm` → result is `heuristic` only (first-ever run after upgrade).
- (c) **id collisions between heuristic and either LLM array → log warning + drop the COLLIDING row, do NOT throw.** The id-namespace separation SHOULD prevent collisions; if it doesn't (corrupted on-disk row, future-format drift, malformed LLM emission), one bad row should not crash the entire rescan chain. Mirror the persona Stage-2 drop-with-log recovery semantic.
- (d) **`mode = { projectId }` with `incomingLlm` containing rows for OTHER projects → log warning + drop the off-project rows, retain the in-project ones, do NOT throw.** Same rationale: a skill contract violation by the LLM shouldn't crash the merge.
- (e) Row order in the output: heuristic rows first (matches legacy disk order), then LLM rows ordered by `confidence` desc within each projectId.
- (f) **`mode` argument with garbage type → throw `TypeError`.** This IS a programmer-error case (calling code is wrong), not a data-quality case; throw is appropriate.

### Row classification — `NarrativeAttribution` four-way bucketing

`packages/schema/src/narrative.ts:NarrativeAttribution` has FOUR values: `'deterministic' | 'deterministic-with-prior' | 'llm-derived' | 'falsifier-verified'`. The merge helper buckets them as follows:

| attributedTo | Bucket | Rationale |
|---|---|---|
| `deterministic` | `heuristic` | Pure-kernel output; the heuristic kernel emits this. |
| `deterministic-with-prior` | `heuristic` | Calibrated heuristic; still emitted by the deterministic kernel, just with a kernel-specific prior applied. Belongs with the heuristic family. |
| `llm-derived` | `existingLlm` (or `incomingLlm`) | This V1's Stage-2 output. |
| `falsifier-verified` | `existingLlm` (or `incomingLlm`) | A `llm-derived` row that subsequently passed `/falsify`. Stays in the LLM family because that's where the row originated. |
| missing (legacy row) | `heuristic` | Normalized by `normalizeNarrativeRow` to `'deterministic'` before classification. |

This classification is exported as `classifyAttribution(row): 'heuristic' | 'llm'` from `@chat-arch/analysis` and used by the skill, the exporter writer-side migration, and the clear-narratives endpoint. **All three callers MUST route every disk-read row through `classifyAttribution` (which itself routes through `normalizeNarrativeRow`)** — direct `filter(r => r.attributedTo === 'deterministic')` calls in caller code are an anti-pattern that silently drops `deterministic-with-prior` / `falsifier-verified` rows.

The exporter calls `mergeNarrativeFamilies({ heuristic: newRescanRows, existingLlm: readDisk().filter(r => classifyAttribution(r) === 'llm'), mode: 'full-rewrite' })` on every rescan. The skill calls `mergeNarrativeFamilies({ heuristic: readDisk().filter(r => classifyAttribution(r) === 'heuristic'), existingLlm: readDisk().filter(r => classifyAttribution(r) === 'llm'), incomingLlm: thisRunRows, mode: chainScanMode ? 'full-rewrite' : { projectId } })` on every Stage 2 write. **Both writers serialize via `atomicWriteJson(narrativesPath, JSON.stringify(buildNarrativesFileObject({ ... }, passthrough), null, 2) + '\n')` (string signature; no opts arg in V1).** The skill, running in `claude -p`, achieves the same tmp+rename via Bash (`Write tmp; mv tmp final`) — see §"Skill template" Stage 2c.

### Concurrency model — the double-writer race

`narratives.json` has TWO writers in V1: the exporter (via `runAnalysis` → `discoverNarratives` → `atomicWriteJson(path, JSON.stringify(fileObj))`) and the skill (Stage 2 write via Bash tool `Write tmp; mv tmp final`). Concurrent operation could race. V1 mitigates with three mechanisms:

1. **Per-endpoint `inFlight` serializer** prevents two `/api/mine-narratives` runs from interleaving (pattern inherited from `mine-persona.ts`). The same applies to `/api/rescan` (existing). **Caveat:** each endpoint's `inFlight` is module-scoped to that endpoint's file (`rescan.ts` and `mine-narratives.ts` each have their own). The serializers do NOT coordinate across endpoints, so a direct POST to `/api/rescan` during a `/api/mine-narratives` run is server-unblocked.
2. **Chain orchestrator is strictly sequential** (client-side, in the browser): `fullScan.ts:runFullScan` awaits each step's NDJSON `done` event before firing the next, so rescan (step 1) cannot overlap with mine-narratives (step 6) within a single SCAN button click. This is in-browser sequencing, NOT cross-endpoint server coordination — a curl-bash direct POST bypasses it.
3. **Read-modify-write through `mergeNarrativeFamilies` on BOTH writers + tmp+rename on both writers.** Exporter side: `atomicWriteJson(path, serialized)` (the existing helper — stamped tmp path + `fs.rename`). Skill side: Bash tool with `Write narratives.json.tmp.<requestId>` followed by `mv narratives.json.tmp.<requestId> narratives.json` — same tmp+rename pattern, just driven from the skill subprocess instead of via Node fs. Both paths guarantee readers never observe a partially-written file (rename is atomic at the POSIX FS metadata layer; on Windows, `MoveFileExW + REPLACE_EXISTING` is atomic with the caveat that the rename can EBUSY when a reader holds the target open — readers should open with `r` mode + retry on EBUSY/ENOENT). On the rare Windows EBUSY surfacing in practice, V1.1 adds a 5-attempt exponential-backoff retry helper.

**The genuine race window** (downgraded honestly from prior spec drafts): a manual direct POST to `/api/rescan` (or a chain re-fire while a manual REGEN NARRATIVES is in flight) CAN race with `/api/mine-narratives`'s read-modify-write. Scenario: skill starts Stage 2 read at T1; rescan completes at T2; skill writes at T3 using stale T1 heuristic rows. Net effect: skill's write overwrites the rescan's freshly-rewritten heuristic family with the previous-rescan's stale heuristic rows (the skill preserves the family it READ at T1, not the family on disk at T3).

V1 mitigates with **compare-and-swap on rescan timestamp**: the skill captures `narratives.json`'s `generatedAt` at T1, re-reads just before the write at T3, and aborts-with-retry if `generatedAt` changed. One retry; on second mismatch, surface as `status: 'concurrent-rescan-aborted'` in the status file and skip the project. The retry consumes additional `maxLlmUsdPerProject` budget (Stage 2's bucket sub-agents + synthesis sub-agent re-fire); the retry's spend counts against the next-scan's budget naturally — a project that keeps losing CAS races persistently is a deployment problem the user should see, not a budget violation to police. (Earlier drafts said "if a CAS retry would push the project over `maxLlmUsdPerProject`, write `concurrent-rescan-aborted` without retrying" — but the skill cannot reliably introspect its prior LLM spend from within `claude -p`, so that budget-aware retry decision is not implementable in V1. The §"Stage 2c" execution rule below is authoritative.) V1.1 promotes this to a real shared-write-lock if observed in the field. The CAS is documented in `Stage 2c` execution rules.

**A third writer: `/api/clear-narratives`.** The clear endpoint is also a read-modify-write writer that lacks a CAS pairing against rescan. Scenario: clear reads `narratives.json` at T1; rescan completes at T2 (writing fresh heuristic rows + new `skipped[]`); clear writes at T3 using the T1-captured heuristic rows + `skipped: []`. Net: clear silently restores the previous-rescan's heuristic family and erases the freshly-rescanned one. V1 accepts this as a known limitation — the clear endpoint is dev-only, manually-triggered, and rarely racing rescan. V1.1 either adds CAS to clear or extends `isMineNarrativesInFlight`-style cross-endpoint coordination to gate clear during rescan as well. Documented here so a future reader doesn't read "No other concurrent-write hazard" as exhaustive.

**Modulo the clear-narratives gap above, no other concurrent-write hazard.** The combination of CAS (skill side only) + per-endpoint inFlights + atomic-rename closes every other interleaving the design has surfaced.

### `analysis/narrative-candidates.json` — Stage 1 intermediate

```jsonc
{
  "version": 1,                          // wire-format version
  "heuristicVersion": 1,                 // bumped when candidate extractor regex/policy changes
  "generatedAt": 1716673200000,
  "thresholds": {
    "minSessionsForLlm": 20,
    "maxSessionsForCorpus": 200,
    "maxLlmUsdPerProject": 0.50,
    "evidenceMinPerNarrative": 2
  },
  "projects": [
    {
      "projectId": "proj_chat-arch",
      "projectName": "chat-arch",
      "sessionsTotal": 627,
      "sessionsSampled": 200,             // capped per maxSessionsForCorpus, stratified-by-recency
      "sessionsWithCandidates": 162,           // sessions that produced ≥1 candidate
      "earliestSampledAt": 1700000000000,
      "latestSampledAt": 1716673200000,
      "candidatesByBucket": {
        "founding":  [ { "sessionId": "...", "updatedAt": ..., "title": "...", "previewExcerpt": "...", "summaryExcerpt": "...", "sentimentPolarity": "positive", "sentimentStrength": 3, "outcomeMarkers": ["shipped", "merged"] } ],
        "mid-early": [ ... ],
        "mid-late":  [ ... ],
        "recent":    [ ... ]
      }
    },
    {
      "projectId": "proj_shopforge",
      "projectName": "shopforge",
      "sessionsTotal": 9,                  // below minSessionsForLlm — Stage 2 will skip
      "sessionsSampled": 9,
      "sessionsWithCandidates": 6,
      "earliestSampledAt": ...,
      "latestSampledAt": ...,
      "candidatesByBucket": { "founding": [...], "mid-early": [], "mid-late": [...], "recent": [...] }
    }
  ]
}
```

PII classification: **high.** Every emitted candidate is a verbatim session title + preview/summary excerpt. Covered by the existing `apps/standalone/public/chat-arch-data/*` gitignore wildcard.

### `analysis/narrative-status-${requestId}.json` — per-run progress

Same shape as `persona-status-*.json`:

```json
{
  "requestId": "<id>",
  "status": "starting" | "bucketing" | "synthesizing" | "writing" | "complete" | "error",
  "progress": { "phase": "<current>", "current": N, "total": M },
  "startedAt": <ms>,
  "updatedAt": <ms>,
  "log": ["<recent message>", "..."],
  "error": "<message if status=error>"
}
```

The viewer polls this file while the run is in flight. `/api/clear-narratives` sweeps all matching status files at the end of a run.

---

## Skill template

`.claude/skills/mine-narratives/SKILL.md` follows the existing `mine-persona` skill structure (which already mirrors `mine-corrections`). Pipeline:

- **Stage 1 (heuristic, pre-skill):** `narrativeCandidates.ts` runs as part of `runAnalysis`, after `discoverNarratives`. It re-uses `discoverNarratives`'s sentiment-scoring helper (`scoreSentiment`) per session, then emits per-project candidate evidence pre-bucketed by recency quartile. Output: `narrative-candidates.json`. (NB: `narrative-candidates.json` carries `previewExcerpt` + `summaryExcerpt` + `outcomeMarkers` per session that `narratives.json` does NOT — the two sidecars overlap on sessionId but carry different per-session payloads. Stage 2 sub-agents need the richer per-session payload.)
- **Stage 2 (LLM, skill-driven):**
  - **Stage 2a — per-bucket sub-agents:** for each eligible project, dispatch **4 parallel sub-agents** (one per recency quartile). Each sub-agent receives the bucket's candidate rows + project name and returns up to 4 thematic-narrative observations with verbatim evidence. This mirrors persona-mining's 4-bucket fan-out; the iter-1 persona stat-rigor finding (recency-only bias) is closed structurally by stratified sampling — same fix applies here. Malformed-JSON / failed-spawn recovery: retry once; on second failure, drop that bucket with a log line in the status file (inherits the recovery semantic from `mine-persona/SKILL.md`, which the new skill mirrors line-for-line).
  - **Stage 2b — cross-bucket synthesis (per project):** one synthesis sub-agent per project combines the four bucket outputs, deduplicates similar observations, and emits 3-8 final narratives with full `provenance` triples + `evidence` arrays. Narratives that appear in ≥2 buckets are flagged "durable" in the inference text; recent-only narratives are flagged "emerging — durability uncertain." Malformed-JSON / validation-failure recovery: retry once; on second failure, write a `{ projectId, status: 'synthesis-failed', reason }` row into the `skipped[]` field, drop the project's LLM rows for this run (preserving any existing on-disk LLM rows untouched via the `mode: { projectId }` merge), continue with remaining projects.
  - **Stage 2c — confidence stamping (deterministic, in-skill, NO LLM):** after Stage 2b returns its rows, the skill (in-process) loops each row and stamps the fields the LLM does NOT emit:
    - `attributedTo: 'llm-derived'`
    - `verifiedAt: null`
    - `confidence: computeConfidence(supportingCount, contradictingCount, THRESHOLDS.narrativeRung.defaultPrior)` (which resolves to 2 today)
    - `actionType: sentiment === 'positive' ? 'encode-as-pattern' : 'generate-corrective-prompt'` (matches the heuristic kernel's policy and is required by `validateNarrative`'s actionType-vs-sentiment check)
    - `schemaVersion: 2`
    - `generatedAt: new Date(now).toISOString()`

    Then `validateNarrative(row)` runs per row. Validation throw paths to drop on: (1) sentiment === 'neutral' (the Stage 2 polarization rule should prevent this; defense-in-depth); (2) missing/empty provenance.{intent,observation,inference}; (3) actionType-vs-sentiment mismatch (impossible if 2c stamps correctly; assertion); (4) confidence not in [0,1]; (5) supporting/contradicting not non-negative; (6) projectId === UNASSIGNED. Rows that fail are dropped with a log line.

    **Post-drop survivor rule:** if `survivors >= minPerProject (3)` → emit survivors and DO NOT emit a `skipped[]` row. If `survivors < minPerProject` → DISCARD the project's entire LLM emission for this run, emit `{ projectId, status: 'synthesis-failed', reason: '<N>/<M> narratives failed validateNarrative' }` into `skipped[]`, preserve any prior on-disk LLM rows for that project untouched (`mode: { projectId }`, `incomingLlm: []`). This prevents a project from simultaneously appearing in both the LLM-rendered cards AND the skipped list — a UI ambiguity `ProjectsMode.tsx` has no answer for.

    **SessionId-membership check (V1 hallucination guard):** Stage 2c also intersects each row's `sessionIds[]` and `evidence[].sessionId` with the Stage-1 candidate set for this project (read from `narrative-candidates.json` at the start of Stage 0). Drop any row where ANY cited sessionId is not in the Stage-1 set, with log line `"sessionId <sid> not in Stage-1 candidate set for project <projectId>"`. This closes the LLM-hallucination gap without depending on V1.1's falsifier — a hallucinated sessionId would otherwise pass `validateNarrative` and break the `[SID:...]` click-through silently in ProjectsMode.

    **SupportingCount floor check:** also drop rows whose `supportingCount < THRESHOLDS.narrative.evidenceMinPerNarrative` (default 2). The Stage 2a "≥2 distinct supportingSessionIds per observation" rule operates at emission; a downstream dedup/session-resolution step could reduce supporting below the floor. Closes the gap between emission-time and confidence-compute-time evidence count. Without this check, the "tier-1 unreachable for LLM rows" claim in §"Confidence ladder participation" depends on emission-side enforcement that has no mechanical check.

    **Concurrent-rescan CAS:** at the start of Stage 2c (after Stage 2b returns), capture `existingNarrativesGeneratedAt = readDisk().generatedAt`. Before the write, re-read; if `generatedAt` differs from the captured value, **retry the full Stage 2 ONCE without further conditioning** — the skill cannot reliably introspect its prior LLM spend from within `claude -p`, so a budget-aware retry decision is not implementable in V1. After one retry: if the CAS mismatches again, write `status: 'concurrent-rescan-aborted'` and exit cleanly (the rescan's write is canonical; the LLM rows are wasted for this run). The retry's spend counts against the next-scan's budget naturally — a project that keeps losing CAS races persistently is already a deployment problem the user should see, not a budget violation to police. See §"Concurrency model" for rationale.

    Stage 2c is the load-bearing pre-write gate: nothing reaches `narratives.json` without passing `validateNarrative` + the sessionId-membership check + the supportingCount-floor check + the CAS.

    **Calibration fail-safe note (V1 trade-off — be honest):** Stage 2c passes `THRESHOLDS.narrativeRung.defaultPrior` (resolves to 2) to `computeConfidence` directly, bypassing `effectivePriorForKernel`. This is a deliberate **visibility-vs-safety trade-off**, NOT a strengthening of the safety net:

    - `effectivePriorForKernel` for an uncalibrated kernel returns `uncalibratedPrior=20`, which with `supporting=6, contradicting=0` produces `confidence=6/26=0.23` — below the tier-1 floor (0.33). Result: every row is tier-0 (NOT surfaced at all) until the kernel calibrates.
    - V1's `defaultPrior=2 + cap-to-tier-2` produces `confidence=6/8=0.75` clamped to tier-2 (curator-feed eligible — surfaced).

    The cap is strictly WEAKER than the uncalibrated-prior fail-safe (tier-2 vs tier-0). V1 deliberately chooses surface-with-cap over suppress-entirely so users see SOMETHING from narrative-mining on day one rather than waiting for the calibration row to be filled in. The trade-off is disclosed in `MethodologyDisclosure`: "V1 LLM narratives are surfaced at tier-2 without the uncalibrated-prior fail-safe; treat as exploratory until calibration completes." V1.1 either wires the LLM-narrative kernel through `effectivePriorForKernel` with a registered `analyzers.calibration_completed_at` row (accepting tier-0 suppression until calibration), OR keeps the bypass with an explicit disclaim — design decision in V1.1.
  - **Output target:** the skill (a) reads `narratives.json` as a generic object, (b) routes every row through `normalizeNarrativeRow` then `classifyAttribution` to split heuristic vs LLM rows (rows classified as `'unknown'` are dropped with a log line), (c) calls `mergeNarrativeFamilies({ heuristic: heuristicRows, existingLlm: existingLlmRows, incomingLlm: thisRunLlmRows, mode: <see §"Merge policy"> })`, (d) assembles the new file via `buildNarrativesFileObject(...)` updating `skipped[]` with this run's skip rows + PRESERVING the existing `thresholds` snapshot + forwarding unrecognized top-level keys via `_passthrough`, (e) serializes via `JSON.stringify(fileObj, null, 2) + '\n'`, (f) writes through Bash tool: `Write narratives.json.tmp.<requestId>` followed by `mv narratives.json.tmp.<requestId> narratives.json`. The mv-rename gives the skill the same atomicity guarantee as the exporter's `atomicWriteJson`. **Cleanup:** if the skill's `claude -p` subprocess is killed between Write and mv, a `.tmp.<requestId>.json` orphan remains; `/api/clear` and `/api/clear-narratives` sweep these (pattern `narratives.json.tmp.*`) so a single failed run doesn't leak indefinitely. LLM rows for projects this run did NOT touch are preserved.
- **Stage 3 (falsifier hookup — DEFERRED V1.1):** Stage-2c emits `attributedTo: 'llm-derived'` + `verifiedAt: null` so the existing `/falsify` skill can verify the evidence chain in a follow-up PR. No V1 code change.

**Per-project sub-agent prompt template (Stage 2a):** mirrors the persona-mining bucket template but anchored on themes-from-sessions instead of patterns-from-prompts. Sub-agent receives `{ projectName, bucketLabel, sessionRows: [{ sessionId, title, previewExcerpt, summaryExcerpt, sentimentPolarity, outcomeMarkers, updatedAt }, ...] }` and returns:

```json
{
  "bucketLabel": "<founding|mid-early|mid-late|recent>",
  "observations": [
    {
      "narrativeTheme": "<one-sentence theme>",
      "intent": "<what we were looking for in this bucket>",
      "observation": "<concrete pattern across N sessions>",
      "inference": "<load-bearing claim>",
      "sentiment": "positive" | "negative",
      "supportingSessionIds": ["<full sid>", ...],
      "evidence": [
        { "sessionId": "<full sid>", "excerpt": "<verbatim title or preview excerpt, ≤200 chars>" },
        ...
      ]
    }
  ],
  "bucketEmpty": false
}
```

Constraints non-negotiable: every excerpt verbatim from the input; ≥2 distinct supportingSessionIds per observation (lower than this → drop, the iter-1 stat-rigor finding from persona-mining applies); 0-4 observations per bucket; `bucketEmpty: true` when no durable theme found.

**Sentiment-polarization rule for non-polar themes (binary-only validator constraint).** `validateNarrative` throws on `sentiment === 'neutral'`. Many durable themes are descriptive ("ShopForge ships marketplace integrations weekly", "user prefers spec-first prompts") and have no natural good/bad polarity. The Stage 2a/2b prompt MUST instruct the sub-agent to: (a) compute the outcome-majority polarity from the theme's `supportingSessionIds` — count how many of those sessions have `sentimentPolarity === 'positive'` vs `'negative'` in the input; (b) emit `sentiment` matching the strict majority (positive if positive-sessions strictly outnumber negative-sessions; negative if the reverse); (c) **DROP the theme** if there is no strict majority (ties → drop). Drop semantics surface as `bucketEmpty: true` for that observation slot in Stage 2a; in Stage 2b they reduce the project's emitted narrative count (and may push the project into `synthesis-failed`/`no-durable-themes` if the drop count drives below `minPerProject`). NEVER emit `sentiment: 'neutral'` — the schema doesn't accept it, and force-polarizing ambiguous themes poisons signal worse than dropping.

**Per-project synthesis prompt template (Stage 2b):** receives the 4 bucket outputs and emits:

```json
{
  "projectId": "<id>",
  "narratives": [
    {
      "id": "narr_llm_<projectId>_<run-uuid-fragment>",
      "title": "<5-15 word title>",
      "body": "<2-4 paragraph synthesis>",
      "sentiment": "positive" | "negative",
      "sessionIds": [...all supporting sids across the bucket-bucket merge...],
      "evidence": [...≥2 evidence rows from the bucket inputs verbatim...],
      "provenance": { "intent": "...", "observation": "...", "inference": "..." },
      "supportingCount": <int>,
      "contradictingCount": 0
      // confidence + attributedTo + verifiedAt stamped post-LLM in Stage 2c — not emitted by the LLM.
    }
  ]
}
```

**Id stability — DELIBERATELY NON-IDEMPOTENT.** V1 makes no claim that repeated runs produce identical ids. The id is a fresh UUID fragment per Stage 2b emission. Rationale: the bucket sub-agents (Stage 2a) are LLM-driven and pick different `supportingSessionIds` across runs even from identical Stage-1 input — there is no deterministic LLM transcript over the same prompt, so any hash-based id over LLM-chosen sids is unstable in practice. REGEN semantics for narratives are **wipe-and-rewrite per-project** (see §"Merge policy" `mode: { projectId }`): the prior LLM rows for that project are evicted, the new rows are appended. Cross-run diffability is a V1.1 concern (handled then via a Stage-2 cache keyed on Stage-1 candidate-set hash + temperature=0 + a deterministic seed — out of scope for V1).

Synthesis stage applies **count limits**: emit min `THRESHOLDS.narrative.minPerProject` (3) and max `THRESHOLDS.narrative.maxPerProject` (8). Below 3 distinct durable themes the synthesis stage emits what it has (no padding); above 8 it merges the lowest-evidence themes. Merged narratives carry a `merged: true` field (additive optional) so the V1 tier-cap (§"V1 tier-cap rule") can refuse tier-3 promotion of merged rows until per-component evidence is hand-verified.

**No candidate-count budget gate in V1.** Per the iter-4 audit, `candidateBudgetProxy` is unreachable as designed when `maxSessionsForCorpus=200` × 1 candidate/session caps each project at ≤200 candidates. V1's only budget mechanism is `maxLlmUsdPerProject` (default $0.50) — projects whose first Stage-2 sub-agent already lands over this cap get a `budget-exceeded` skip-row. V1.1 may re-add a candidate-count gate once empirical per-project candidate counts justify it.

---

## Confidence ladder participation

LLM-derived narratives compute confidence via the existing `computeConfidence(supporting, contradicting, prior)` formula (Phase Rev3-B, gated by `THRESHOLDS.narrativeRung.tier1/2/3`). Stage 2c (deterministic, in-skill) stamps `confidence = supportingCount / (supportingCount + contradictingCount + defaultPrior=2)`. With V1's hardcoded `contradictingCount: 0` (no contrary-evidence finder until V1.1):

- **`supporting=2, contradicting=0`** → confidence `2/(2+0+2) = 0.5` → **exactly the tier-2 floor.** This is the modal V1 LLM row outcome: the `evidenceMinPerNarrative=2` rule (§"Skill template") guarantees every emitted LLM row has supporting ≥ 2, so every row clears `narrativeRung.tier2` by construction.
- `supporting=3, contradicting=0` → confidence `3/(3+0+2) = 0.6` → tier-2 (0.5 ≤ x < 0.66).
- `supporting=6, contradicting=0` → confidence `6/(6+0+2) = 0.75` → would clear tier-3 (0.66) absent the V1 cap below; with the cap, stays at tier-2.
- `supporting=12, contradicting=0` → confidence `12/(12+0+2) = 0.857`.

**Ladder degeneracy under V1.** Combined with the V1 cap (next section), every LLM row lands at exactly tier-2 — never tier-1, never tier-3. Tier-1 is unreachable because the evidence-min rule forces supporting ≥ 2; tier-3 is unreachable because the cap clamps it. The ladder's discrimination is restored in V1.1 once the contrary-evidence finder lands: `supporting=2, contradicting=1` → `2/(2+1+2) = 0.4` → drops to tier-1, restoring all three rungs as meaningful.

The tier-3 joint-gate (`thresholds.ts:172-177`) was designed so that high-confidence narratives must withstand SOME contrary evidence — `contradicting ≤ ceil(supporting/6)` only does work when `contradicting > 0`. V1 hardcoding `contradicting = 0` makes the contradicting-cap trivially satisfied and bypasses the gate's load-bearing function. **This is a real V1 risk** — at the spec's `maxPerProject=8` target, with the synthesizer aiming for narratives spanning many sessions, the supporting=6+ case is plausibly common, though V1 has zero empirical data on synthesizer evidence-attribution. The V1 cap is belt-and-suspenders relative to `tier3SupportingMin=6` — the latter may already be doing all the work; calibration after first run will tell.

### V1 tier-cap rule

V1 enforces an explicit tier-cap on LLM narratives by extending `narrativeTier()`'s signature to accept row-metadata (see Modified files §"narrativeRung.ts"). The cap is embedded inside `narrativeTier()` itself — NOT a sibling helper — to preserve the file's "single point of truth" invariant (`narrativeRung.ts:134-136`):

> The cap is ACTIVE (tier clamped to ≤ 2) when:
> ```
> opts.attributedTo === 'llm-derived'
> ```
> Unconditional in V1. The cap is REMOVED in V1.1 — that's when the contrary-evidence finder lands and a real tier-3 promotion becomes meaningful.

Practical effect: V1 LLM narratives are curator-feed eligible (tier-2 reach) but never action-eligible (tier-3 / `encode-as-pattern`). Because the cap is INSIDE `narrativeTier`, every existing caller (curator-feed builder, ProjectsMode tier-badge renderer, any future brief-kernel / SDK / MCP consumer) gets the cap automatically — no enumeration-of-callers risk.

**Why no conditional cap-exemption in V1.** Earlier drafts wired an exemption gated on `verifiedAt !== null && contradicting > 0` so V1.1 could "just delete the clause" — but `contradictingCount` is hardcoded 0 in V1 (no contrary-evidence finder until V1.1), making the exemption inactive even for falsifier-verified rows. Wiring dead code into V1 buys nothing: V1.1 has to touch `narrativeTier` to remove the cap anyway, whether or not the exemption clause was already there. The simpler V1 predicate is the right choice.

Pre-launch placeholders for `narrative.*` thresholds; calibrate against hand-labels after the first 50 LLM narratives land. **Calibration plan tracked in CHANGELOG `[1.7.0]` calibration notes.** Mirrors persona-mining's calibration discipline.

---

## Chain integration

`FULL_SCAN_STEPS` becomes:

```ts
[
  { id: 'rescan',     label: 'rescan (exporter)',  url: '/api/rescan',           header: 'chat-arch-rescan' },
  { id: 'mine',       label: 'mine corrections',   url: '/api/mine-corrections', header: 'chat-arch-mine-corrections' },
  { id: 'curate',     label: 'curate feed',        url: '/api/curate',           header: 'chat-arch-curate' },
  { id: 'falsify',    label: 'falsify findings',   url: '/api/falsify',          header: 'chat-arch-falsify' },
  { id: 'persona',    label: 'mine personas',      url: '/api/mine-persona',     header: 'chat-arch-mine-persona' },
  { id: 'narratives', label: 'mine narratives',    url: '/api/mine-narratives',  header: 'chat-arch-mine-narratives' },
]
```

**Position rationale (narratives AFTER persona):** narrative synthesis depends on the project list + manifest being current (rescan provides this) but has no dependency on personas, corrections, curator, or falsifier output. Placing narratives last (a) keeps the chain monotonic — each step's outputs are a superset of available evidence for downstream steps — and (b) means a failure in narratives doesn't halt earlier steps' artifacts from landing. Failure semantics unchanged: any step failure halts the chain; narratives failing means the chain's terminal step did not complete, and the page reload still shows everything earlier that did.

**Sequential await is mechanical, not aspirational.** `fullScan.ts:runFullScan` awaits each step's NDJSON `done` event before firing the next (see `runOneStep` return + the for-loop pattern in `apps/standalone/src/scripts/fullScan.ts`). Step 6 cannot fire before step 5's stream closes. The fullScan test should add (a) a step-count assertion of 6, (b) header-pinning for `chat-arch-mine-narratives`, and (c) an ordering assertion that mocks step 5 (persona) returning a long-running NDJSON stream and asserts step 6 never POSTs until step 5's done event lands.

The fullScan test grows from 5 to 6 step-count assertions + a new header-pinning entry + the ordering assertion. All existing chain-semantics tests reused as 6-step.

### `/api/mine-narratives` endpoint contract

Pinned to avoid the "implementer infers persona-line-for-line" ambiguity:

- `POST /api/mine-narratives`, body `{ projectId?: string, dataDir?: string }`. Both optional.
- CSRF: `Origin` parses to a local-only hostname AND `X-Requested-With === 'chat-arch-mine-narratives'`. Reject 403 otherwise.
- `projectId` sanitization: when present, MUST match `/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,126}[a-zA-Z0-9])?$/` (forbids leading/trailing `-`, `_`, or `.` to block argv-flag-shaped values like `--evil`; min 1 char, max 128 chars; allows internal `.` for namespace-style project ids like `proj.shopforge`) AND MUST exist in the current `analysis/projects.json`'s `projects[].id` list (the per-rescan canonical project inventory). Reject 400 on either failure. (Earlier drafts of this spec referenced `manifest.json` as the membership source; that file's `sessions[]` records have `project` fields but no flat project-id array, so `analysis/projects.json` is the implementation-side source of truth — the impl at `apps/standalone/src/pages/api/mine-narratives.ts:readKnownProjectIds` reads it directly.)

  **Defense-in-depth caveat:** the regex closes the INPUT-LAYER injection surface. The spawned `claude -p ${prompt}` uses `shell: bin.useShell` (true on Windows for the PATH-fallback path per `resolveClaude.ts`), so the projectId still flows through cmd.exe quoting at the shell layer. The regex's allowed character class (`[a-zA-Z0-9_.-]`) is safe under cmd.exe quoting (no metacharacters), so the surface is closed end-to-end. If a future tightening admits whitespace, semicolons, or ampersands, the shell-quoting layer becomes a re-introduced sink — tracked in §"Out of scope" as a follow-up to drop `shell: true` on the resolveClaude PATH-fallback. (Sibling task: persona endpoint inherits the same input-layer gap; spec note in §"Out of scope".)
- `dataDir`: passed through `assertDataDirContained(...)` (existing helper from `mine-persona.ts`), no new guard needed.
- `inFlight`: per-endpoint serializer mirroring `mine-persona.ts` — returns 409 when busy.
- `projectId` absent → mine all eligible projects (SCAN-chain mode). Present → mine only that project (REGEN button mode). The skill receives `--project-id=<id>` via argv only when the endpoint forwards a sanitized value.
- Response: NDJSON stream (200) with `start` / `phase` / `stdout` / `stderr` / `done` events, mirroring `mine-persona.ts`.
- Stand-alone REGEN path (no SCAN): the per-project REGEN NARRATIVES button POSTs `{ projectId }` directly to this endpoint. No chain involvement, no `fullScan.ts` orchestration.

**Silent-abort detection — `NarrativeOutcomeProbe`.** Mirror `PersonaOutcomeProbe` (mine-persona.ts:83-90). The probe shape:

```ts
interface NarrativeOutcomeProbe {
  /** generatedAt from narratives.json on disk after the run, or null. */
  narrativesGeneratedAt: number | null;
  /** status from narrative-status-<requestId>.json, or null. */
  statusFileStatus: string | null;
  /** error from narrative-status-<requestId>.json, or null. */
  statusFileError: string | null;
}
```

Because `narratives.json` already exists before the skill runs (the exporter wrote it), checking `narratives.json.generatedAt < startedAt` is NECESSARY but NOT SUFFICIENT (a rescan that completed between `startedAt` and the skill's write would give a false-positive fresh timestamp). The principled probe: require BOTH the status file's `status === 'complete'` AND `narrativesGeneratedAt >= startedAt`. The status file write at the end of Stage 3 (index merge) is the canonical "skill actually wrote" sentinel; the timestamp check is a sanity guard for partial-write recovery. If the status file is absent → silent abort. If status === 'error' → reported error. If status === 'complete' but narratives.json timestamp is stale → spawn error mid-write; treat as failure with a specific error string.

### `/api/clear-narratives` endpoint contract

Pinned parallel to `/api/mine-narratives` so the implementer doesn't have to infer semantics from one-line file-changes-table descriptions:

- `POST /api/clear-narratives`, body `{}` (no per-project scope — wipes ALL LLM narratives across all projects in one call).
- CSRF: `Origin` parses to a local-only hostname AND `X-Requested-With === 'chat-arch-clear-narratives'`. Reject 403 otherwise.
- **Read-modify-write semantics with unknown-field round-trip:** parse `narratives.json` as a generic object → use `classifyAttribution(normalizeNarrativeRow(row))` to filter rows → call `mergeNarrativeFamilies({ heuristic: heuristicRows, existingLlm: [], mode: 'full-rewrite' })` → assemble the new file via `buildNarrativesFileObject(...)` **with the original top-level object's unrecognized keys forwarded via the `_passthrough` opts** → write through `await atomicWriteJson(narrativesPath, JSON.stringify(fileObj, null, 2) + '\n')`. The standard "round-trip unknown fields" pattern codifies the writer-side forward-compat policy that pairs with the reader-side policy in §"First-run-after-upgrade migration". Preserves all heuristic rows; removes all LLM rows; clears the `skipped[]` field (a fresh narrative-mining run will rebuild it); `thresholds` snapshot is preserved (methodology-disclosure field, not a per-run artifact).
- **`classifyAttribution`-driven filter:** must NOT inline a strict `attributedTo === 'deterministic'` filter. Use `classifyAttribution(normalizeNarrativeRow(row)) === 'heuristic'` so `deterministic-with-prior` rows are preserved (and `falsifier-verified` rows are correctly wiped along with the rest of the LLM family).
- **Allowlist drift warning:** mirror the `isPersonaArtifact` precedent (`clear-personas.ts:68-86`): the classification helper + status-file glob must stay in sync with the Stage-2 skill's writes. Adding a new sidecar pattern in the skill without updating these orphans files on disk.
- Status-file sweep: best-effort delete every `analysis/narrative-status-*.json` in the directory.
- `analysis/narrative-candidates.json` is INPUT (written by the exporter), not output — **preserved unchanged**. Matches the `clear-personas.ts` treatment of `persona-candidates.json`.
- inFlight: returns 409 if `/api/mine-narratives` is currently running (re-uses that endpoint's inFlight token). NOT serialized against itself; a clear during a clear is idempotent.
- Response: `{ ok: true, removedNarratives: <int>, removedStatusFiles: <int> }` on 200; `{ ok: false, error: <msg> }` on 5xx. Counts are reported separately so callers can display meaningful totals.
- Static-build deploys (hosted `chat-arch.dev`) without this endpoint return 404 on POST; the dev-only "clear LLM narratives" UI affordance hides via the GET probe pattern from `clear-personas.ts:163-168`.

Test plan addition (also reflected in §"Test plan"): `clear-narratives.test.ts` — assert heuristic rows preserved through a clear; LLM rows removed; unrecognized top-level fields preserved (round-trip test with a synthetic `futureField: 'v2-only'`); `deterministic-with-prior` rows preserved; `falsifier-verified` rows removed (they're in the LLM family); `narrative-candidates.json` untouched; `narrative-status-*.json` files swept; CSRF 403 paths; inFlight 409 path; counts split correctly.

### First-run-after-upgrade migration

Between code-deploy at v1.7.0 and the first post-upgrade rescan, existing on-disk `narratives.json` rows lack the new `attributedTo` / `contradictingCount` / `verifiedAt` fields. The read side must handle these gracefully:

**Reader policy (single source of truth — exported from `@chat-arch/analysis`):**

```ts
function normalizeNarrativeRow(row: Narrative): Narrative {
  return {
    ...row,
    attributedTo: row.attributedTo ?? 'deterministic',
    contradictingCount: row.contradictingCount ?? 0,
    verifiedAt: row.verifiedAt ?? null,
  };
}
```

Every consumer that reads `narratives.json` MUST pipe rows through `normalizeNarrativeRow` before processing. Enumerated consumers: `ProjectsMode.tsx`, `narrativeTier()` (via its `opts` param), `mergeNarrativeFamilies` (when computing the heuristic vs LLM split via `classifyAttribution`), curator-feed builder, clear-narratives.ts.

**Writer-side absent-project rule.** `discoverNarratives` only re-emits rows for projects present in the current scan's `projects` array. The exporter's writer-side migration (modified-files row for `index.ts`) handles this explicitly: read existing on-disk rows → route through `normalizeNarrativeRow` → split via `classifyAttribution` → pass to `mergeNarrativeFamilies({ heuristic: newRescanRows, existingLlm: existingLlmRows, mode: 'full-rewrite' })`. The merge result REPLACES the heuristic family with the new rescan's emissions, which means heuristic rows for projects that disappeared between runs are **dropped** (data hygiene — they reference projects that no longer exist in the manifest). LLM rows for absent projects are similarly dropped because the merge passes only `existingLlm` rows whose projectId is in the current `projects` array. This is the deliberate V1 behavior: removed projects also remove their narratives. Documented in CHANGELOG `[1.7.0]` so users who restore a deleted project know they'll need to REGEN NARRATIVES.

**Effect:** legacy rows render correctly with deterministic attribution and pass through the LLM tier-cap predicate as `attributedTo === 'deterministic'` (cap inactive). Users don't need to run any explicit migration command — pressing SCAN regenerates the heuristic rows with the stamped fields, but the surface stays correct in the meantime. Definition-of-done acceptance check: after first SCAN post-upgrade, every row in `narratives.json` has a populated `attributedTo` field (grep verifies).

**Forward-compat for additive fields removal.** The spec's `thresholds` snapshot + `skipped[]` are additive optional top-level fields. Policy: ALL readers of `narratives.json` MUST treat missing top-level fields as the V1 default (empty `skipped[]`, threshold values pulled from the live `THRESHOLDS.narrative.*` block). This codifies the forward-compat contract a future EXPORTER_VERSION that REMOVES one of these optional fields cannot break — readers fall back to live thresholds, not the absent snapshot.

REGEN BRIEF unchanged. The brief kernel could eventually pull narrative summaries; that's a follow-up.

---

## UI surface — PROJECTS detail page

`packages/viewer/src/components/modes/ProjectsMode.tsx`:

- **Primary narrative cards:** `attributedTo === 'llm-derived'` narratives render first, each as a card with title + body excerpt + provenance triple (intent / observation / inference) shown collapsed-by-default + evidence pills with `[SID:...]` click-through to `/sessions#session/<sid>` + tier badge (tier-1 / tier-2 / tier-3 — drives ordering within `llm-derived`).
- **Heuristic "raw clusters" panel:** below the LLM cards, a collapsed disclosure (`<details>` element) labeled "Raw sentiment clusters (deterministic)" with the existing heuristic narrative cards inside. Expanded only on user click. Preserves the deterministic signal without dominating the surface.
- **Order within LLM family:** by `confidence` desc, then `supportingCount` desc, then `generatedAt` desc. Stable for repeated renders.
- **Drill-in:** click an `[SID:...]` evidence pill → existing `/sessions#session/<sid>` hash route (matches FEED card behavior; no new routing needed).
- **Per-project REGEN button:** "REGEN NARRATIVES" affordance (POSTs `/api/mine-narratives` with `{ projectId }`) — matches the REGEN PERSONA pattern in PR #106.

No sidebar change in V1 (decision §2.3). A NARRATIVES sidebar entry is V1.1 if cross-project listing becomes useful.

```
PROJECTS / chat-arch
┌──────────────────────────────────────────────────┐
│ LLM-DERIVED NARRATIVES (5)        [REGEN NARRATIVES] │
│  ┌─ TIER-3 · CONF 0.75 ─────────────────────────┐│
│  │ Reflexive loop discipline closes the ratchet  ││
│  │ ▸ Provenance / Evidence (12 SIDs)             ││
│  └───────────────────────────────────────────────┘│
│  ... 4 more cards ...                            │
│                                                  │
│  ▸ Raw sentiment clusters (deterministic, 2)     │  ← collapsed disclosure
└──────────────────────────────────────────────────┘
```

---

## Test plan

- **`narrativeCandidates.test.ts`** — fixture-driven; assert 4 quartile buckets fill correctly from a synthetic session set with known recency distribution; verify outcome-marker extraction from session previews; verify `sessionsWithCandidates` count matches the manually-counted ground truth.
- **`mergeNarrativeFamilies.test.ts`** (co-located under `packages/analysis/src/`) — unit tests covering the pinned contract: (a) preserves all heuristic rows; (b) appends all LLM rows; (c) id-namespace collision → logged + colliding row dropped (NOT thrown); (d) `mode = { projectId }` replaces only that project's LLM rows; (e) other projects' LLM rows preserved; (f) `mode = { projectId }` with off-project `incomingLlm` row → off-project row dropped, in-project rows retained, NOT thrown; (g) empty `existingLlm` + empty `incomingLlm` → result is heuristic only; (h) sort order: heuristic first, then LLM by confidence desc within projectId; (i) `mode` with garbage type → TypeError; (j) legacy row missing `attributedTo` → normalized to deterministic via `normalizeNarrativeRow` before classification.
- **`narrativeRung.test.ts` extension** — extend existing tests for `narrativeTier()` with the new V1-cap opts: assert `attributedTo === 'llm-derived'` unconditionally clamps tier to ≤ 2 regardless of confidence / supporting / contradicting (the simplified V1 predicate per §"V1 tier-cap rule"); assert non-`'llm-derived'` attribution values (`'deterministic'`, `'deterministic-with-prior'`, `'falsifier-verified'`) bypass the cap; assert legacy callers without the opts param behave identically to today (back-compat).
- **`atomicWrite.test.ts`** — no changes in V1. The narratives.json writer uses the existing helper unchanged. EBUSY-retry extension deferred to V1.1 if observed empirically.
- **`buildNarrativesFileObject.test.ts`** (new) — assert top-level shape composition; unknown-key round-trip via `_passthrough` opt; null-safe defaults for absent `thresholds`/`skipped` inputs.
- **`normalizeNarrativeRow.test.ts`** — fixture rows with missing `attributedTo` / `contradictingCount` / `verifiedAt` get defaulted to `'deterministic'` / 0 / null; rows with all fields populated pass through unchanged.
- **`fullScan.test.ts` updates** — step count → 6, header-pinning entry for `chat-arch-mine-narratives`, ordering assertion that step 6 awaits step 5's `done` event (mock a long-running step 5 NDJSON stream).
- **`mine-narratives` skill integration test** — mock the `claude -p` spawn (per existing `mine-persona` test pattern), assert `analysis/narratives.json` gains LLM rows with `attributedTo: 'llm-derived'` + `confidence` stamped + `contradictingCount: 0` + `actionType` stamped + `schemaVersion: 2`; status file written; heuristic rows preserved unchanged; on-disk write is atomic-rename (no `.tmp.*` files leak); CAS retry path covered (simulate mid-run rescan changing `generatedAt` between Stage 2c capture and write — assert the skill retries once then aborts cleanly).
- **`mine-narratives.api.test.ts`** — endpoint contract tests: CSRF rejection (cross-origin / missing header), `projectId` sanitization (leading `-`, trailing `_`, special chars rejected 400; unknown projectId rejected 400 — fixture manifest has known set), `inFlight` 409 path, `NarrativeOutcomeProbe` silent-abort detection (status file missing → ok=false; status === 'complete' but stale narrativesGeneratedAt → ok=false with specific reason).
- **`clear-narratives.test.ts`** (new) — assert heuristic rows preserved through a clear; LLM rows removed; `skipped[]` field cleared; `thresholds` snapshot preserved; `narrative-candidates.json` untouched; `narrative-status-*.json` files swept; CSRF 403 paths; 409 when mine-narratives inFlight.
- **`ProjectsMode.test.tsx` update** — fixture has 2 heuristic + 3 LLM narratives for one project; assert (a) 3 LLM cards render first; (b) heuristic cards inside collapsed disclosure; (c) tier badges correct; (d) V1-tier-capped rows never show tier-3 badge; (e) fixture row missing `attributedTo` (legacy migration case) renders correctly as deterministic.
- **`ProjectsMode.test.tsx` skipped-row test** — fixture has a project with `synthesis-failed` skipped-row + zero LLM narratives; assert the surface shows "LLM found no durable narratives" hint, NOT both card-rendering AND skip-listing for the same project.
- **Sentiment-polarization unit test** — fixture has a Stage 2a bucket output with `sentiment: 'neutral'`; assert the skill's validation step drops it cleanly and logs the drop to status (does NOT crash the project's whole run).
- **Manual end-to-end** — click SCAN, verify 6 POSTs in dev server log (each NDJSON stream closes before the next opens), verify `narrative-candidates.json` + LLM rows in `narratives.json` on disk, verify PROJECTS detail page renders the two-tier display, verify REGEN NARRATIVES button works per-project (no other project's LLM rows change), verify CLEAR NARRATIVES wipes only LLM rows.

### Definition of done

Before opening the PR:

- `pnpm lint` clean (no new warnings; max 1 pre-existing warning in `apply-correction.ts` per project precedent).
- `pnpm test` clean (baseline pass count maintained — check the count on `main` immediately before opening the PR; persona-mining landed on 2154+).
- `pnpm build` clean from clean clone.
- Manual: SCAN runs all 6 chain steps; `narratives.json` contains at least one `attributedTo: 'llm-derived'` row for `chat-arch` project after SCAN (the corpus's largest project — guaranteed above `minSessionsForLlm=20`); the LLM row has provenance triple populated and ≥2 evidence pills; PROJECTS detail page renders ≥1 LLM narrative card primary + heuristic cards collapsed.
- Acknowledged V1 limitations (must surface in PR description):
  - `contradictingCount === 0` always (no contrary-finder until V1.1).
  - LLM narratives capped at tier ≤ 2 in V1 (cap embedded inside `narrativeTier()`).
  - REGEN semantics are wipe-and-rewrite per-project — no idempotent id (Stage-2 cache is V1.1).
  - SQLite mirror not written (V1.1).
  - Falsifier hookup not wired (V1.1).

If the auto-generated chat-arch narratives are visibly low-signal (e.g., all 3 emitted narratives are obvious restatements of the heuristic clusters), surface in the PR description as a known V1 calibration limitation — do NOT block on perfecting the synthesis prompt (calibration after first run is in §"Calibration plan").

---

## Out of scope (V1)

Listed here so a future spec can pull from a known menu:

- **Cross-project composite narrative** ("the user's recurring workflow signature across all repos"). One more LLM call regardless of project count; defer until V1 lands.
- **NARRATIVES sidebar entry** with cross-project filtering / browsing. V1 keeps narratives inside their project's detail page.
- **SQLite `narratives` table mirror.** V1 writes sidecar only. V1.1 wires `insertNarrative` + `insertNarrativeEvidence` SDK calls during the merge step so MCP read-only consumers see LLM rows too.
- **Falsifier integration** — verifying every `[SID:...]` evidence excerpt is verbatim-present in the cited session's actual messages. `attributedTo: 'llm-derived'` is the hook; the `/falsify` skill extension is V1.1.
- **Idempotent / cache-keyed Stage-2 re-runs.** V1 REGEN is wipe-and-rewrite; identical Stage-1 input does not yield identical Stage-2 output without LLM determinism controls. V1.1 adds `temperature=0` + a deterministic seed + a Stage-2 output cache keyed on Stage-1 candidate-set hash.
- **`/api/mine-persona` projectId sanitization hardening.** The persona endpoint inherits the same allow-list gap closed in this V1 for `/api/mine-narratives`. Apply the same canonical regex `/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,126}[a-zA-Z0-9])?$/` (matches V1's pinned regex at §"/api/mine-narratives endpoint contract") + manifest-membership check against `analysis/projects.json` to `mine-persona.ts` in a follow-up — out of scope for the narrative-mining PR but documented here so the hole isn't forgotten.
- **Hand-authored canonical exemplar** (analog to `research/persona-evals/bryce.md`). Bryce did not author one; narrative-mining V1 ships without a hand-authored ground-truth benchmark. The heuristic kernel's existing 9 narratives serve as the soft prior (the corpus's two-cluster baseline that LLM narratives must improve on). Calibration after first run substitutes for the missing exemplar.
- **`shell: true` removal on resolveClaude's PATH-fallback path.** The current `shell: bin.useShell` (true on Windows for the PATH-fallback) is a defense-in-depth concern that the projectId regex closes only at the input layer. A follow-up should explicitly resolve `claude.cmd` and use `shell: false` for the spawn, removing the shell-quoting layer entirely. Out of scope for narrative-mining V1; applies to all CLI-spawning endpoints (mine-corrections / mine-persona / mine-narratives).
- **Shared-write-lock for `/api/rescan` + `/api/mine-narratives` cross-endpoint serialization.** V1 mitigates the stale-read race via compare-and-swap on `generatedAt` (see §"Concurrency model"). V1.1 promotes to a real lock file if observed in the field.
- **Two-sidecar architectural alternative.** The spec settles on a single `narratives.json` with `mergeNarrativeFamilies` + tier-cap. An alternative — `narratives.json` (exporter-owned, heuristic-only, single writer) + `llm-narratives.json` (skill-owned, single writer) — eliminates the merge helper, the double-writer race, and the atomic-rename complexity entirely. V1 keeps the merge approach because (a) it matches the existing `narratives.json` consumer wiring (single file read), (b) the merge contract + `atomicWriteJson` + CAS together close the race, and (c) the migration cost of splitting the file is non-trivial (manifest.tiers update, viewer load logic, CLAUDE.md doc rewrites). If V1 calibration surfaces concurrency bugs that the CAS can't catch, V1.1 revisits.
- **Curator-feed surfacing of tier-2+ narratives.** The curator currently reads its inputs from `analysis/curator-feed.json` produced by `/curate`. Pushing tier-2+ LLM narratives into that feed is a V1.1 task — the gate is in the curator, not narrative-mining.
- **Contrary-evidence finder.** V1's `contradictingCount` is always 0 (no kernel surfaces contradicting evidence today). V1.1 adds an explicit "find sessions that contradict this inference" stage so confidence numbers actually reflect both arms.
- **Narrative-drift detection** — diffing successive scans' LLM narratives; flag when a narrative's evidence sids turn over rapidly (signal of changing workflow). Parallel to persona-drift; defer.
- **Hosted-demo narrative generation** — `chat-arch.dev` static deploy has no LLM access; narratives are local-only in V1 (matches persona-mining).
- **Replacing the heuristic kernel.** Even at V2, the heuristic kernel stays — it's the always-available baseline. Removing it would re-introduce the "blank PROJECTS surface when LLM hasn't run yet" failure mode.

---

## Estimated PR shape

Single bundled PR per `feedback_claude_code_paced_prs` (Claude-Code-paced, not human-paced):

- **Wave 1:** schema (`narrativeCandidates.ts` types) + thresholds + heuristic stamping (`attributedTo: 'deterministic'` on existing rows) + `mergeNarrativeFamilies` helper + tests
- **Wave 2:** Stage-1 candidates extractor (`narrativeCandidates.ts` in exporter) + wire into `runAnalysis` + bump `EXPORTER_VERSION` 1.6.0 → 1.7.0 + meta.tiers entry + tests
- **Wave 3:** skill (`mine-narratives/SKILL.md`) + API endpoint (`api/mine-narratives.ts`) + clear endpoint (`api/clear-narratives.ts`) + chain integration (6th step) + clear endpoint orphan-sweep extension
- **Wave 4:** viewer surface (two-tier ProjectsMode rendering + REGEN NARRATIVES button) + ProjectsMode test fixture update
- **Wave 5:** docs (CHANGELOG `[1.7.0]`, CLAUDE.md "Data on disk" + "Shape of workspace" entries, .gitignore explicit `narrative-candidates.json` line — already covered by wildcard, added for auditable documentation) + manual verification

Rough size: ~18-28 files, mostly new, ~1800-2800 LOC including tests. Should comfortably fit one PR with sub-agent fan-out per wave. Larger than persona-mining (PR #106 was ~15-25 files) because of the heuristic-LLM merge policy + ProjectsMode two-tier UI change.

---

## Decision log

| Question | Decision | Rationale |
|---|---|---|
| Per-project, composite, or both? | **Per-project only** | Composite costs 2N LLM calls; defer to V2 once we know V1 lands. Matches persona-mining V1 precedent. |
| When to trigger? | **On SCAN as chain step 6** | Matches existing chain discipline; narratives depend on the manifest but not on personas/corrections/curator/falsifier, so last position is natural. |
| Where to surface? | **PROJECTS detail page; LLM cards primary, heuristic collapsed below** | Narratives are project-scoped; the existing surface has the slot. New sidebar entry would duplicate discoverability for cross-project listing not yet useful. |
| Markdown artifact per project? | **No — JSON-only, card-rendered** | Narratives surface as cards in `ProjectsMode.tsx`, not as full markdown pages. The JSON-only shape matches the existing heuristic-narratives data flow. Persona-mining's `<project-id>.md` exists because personas are long-form prose. |
| Replace or keep heuristic? | **Keep both, id-namespace separated** | Heuristic = always-on baseline, no LLM cost, useful below-threshold projects. LLM = tier-2 themes with provenance (tier-3 only after V1.1). Removing the heuristic re-introduces blank-state failure. |
| Sidecar or SQLite? | **Sidecar primary; SQLite mirror deferred V1.1** | Matches persona-mining V1; SQLite mirror is an MCP-surface concern, not a UI-surface concern; gates V1 scope. |
| Falsifier in V1? | **No — V1.1 follow-up** | Falsifier already works on `attributedTo: 'llm-derived'` findings; narratives just need to emit that field. No V1 code change for the hookup wins V1 scope. |
| Sampling strategy? | **4-quartile stratified-by-recency, mirror `personaCandidates`** | Iter-1 persona stat-rigor finding (recency-only bias) is structurally closed by stratification; reusing the same code path keeps the methodology disclosure single-sourced. |
| Min sessions for LLM? | **20 — placeholder, pre-launch** | Pre-launch guess at "weaker than persona's 30 because narratives are session-level themes (one observation per session) rather than user-voice patterns requiring multiple prompts to triangulate." NO empirical basis yet — explicit placeholder; calibrate against hand-labels after the first 10 runs. |
| LLM budget proxy? | **No — deferred to V1.1** (see row below for rationale) | Earlier drafts proposed `0.8 × persona's 1500 = 1200 candidates` as a per-project proxy, but the iter-4 audit showed it unreachable at `maxSessionsForCorpus=200` × 1 candidate/session. V1's only budget mechanism is `maxLlmUsdPerProject = $0.50`. V1.1 may re-add a per-recency-bucket candidate-count gate once empirical per-project candidate counts justify it. |
| Narrative count per project? | **3-8 (synthesizer-enforced)** | Below 3 → not enough signal to justify LLM call. Above 8 → cards-paralysis on the PROJECTS surface. Tied to curator `precisionAtKTarget=0.3` calibration: at max=8 the worst-case is ~5.6 false positives per project, which is acceptable iff `precisionAtKTarget` holds at 0.3+. Drop max to 5 if precision drops below 0.3 in first calibration. |
| Min evidence per narrative? | **2 distinct sessionIds** | Single-session "narratives" are anecdotes, not themes — the iter-1 persona stat-rigor finding applies identically. |
| Sentiment polarization rule? | **Outcome-majority of supporting sessions; drop on tie** | `validateNarrative` rejects `neutral`. Forcing every theme into positive/negative would poison signal on truly-thematic patterns; dropping ambiguous themes preserves signal at the cost of recall. |
| File-level schemaVersion bump? | **No — additive optional fields only** | New `thresholds` snapshot + `skipped[]` are additive optional top-level fields; existing readers ignore unknown keys. `EXPORTER_VERSION` 1.6.0 → 1.7.0 is the auditable cutover marker. Avoids a second schemaVersion axis (already complicates readers given row-level v1/v2 exists). |
| Id stability across re-runs? | **Non-idempotent: fresh UUID fragment per emission** | Spec previously claimed hash-based stability; the LLM nondeterminism makes the hash unstable in practice. V1 REGEN is wipe-and-rewrite per-project. Cache-keyed idempotence is V1.1. |
| V1 tier-cap on LLM rows? | **Yes — fold into `narrativeTier()` signature, cap to tier ≤ 2 when `attributedTo === 'llm-derived'` (simplified V1 predicate — unconditional)** | Embedding in `narrativeTier` preserves the file's "single point of truth" invariant; no sibling helper, no cap-bypass risk for future callers. The cap is REMOVED in V1.1 (one-line deletion of the clamp clause inside `narrativeTier`) when the contrary-evidence finder lands. See §"V1 tier-cap rule" and §"Why no conditional cap-exemption in V1" for the simplification rationale. |
| Falsifier cap exemption? | **None in V1** | Earlier drafts proposed an exemption gated on `verifiedAt !== null && contradicting > 0`, but V1's hardcoded `contradicting=0` makes the exemption inactive even for hypothetically-verified rows. V1.1 removes the cap entirely (no exemption needed); wiring dead conditional code into V1 buys nothing. |
| Empirical canonical exemplar? | **No — heuristic narratives + soft-prior calibration** | No hand-authored equivalent of `bryce.md` exists for narratives. V1 ships without one; the heuristic kernel's 9 existing narratives serve as the baseline to beat. Tracked in Out-of-scope as a V1.1 deliverable. |
| projectId sanitization at API? | **Yes — `/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,126}[a-zA-Z0-9])?$/` + manifest-membership** | Forbids leading/trailing punctuation (blocks argv-flag-shaped values); allows `.` for namespace ids. The regex closes the input layer; the shell-quoting layer is closed by the regex's safe-char-class but tracked separately as a defense-in-depth follow-up. |
| Merge throw vs drop semantics? | **Drop-with-log on collisions / off-project rows; throw on programmer-error (`mode` garbage type)** | Avoids "one bad row crashes the rescan chain" footgun. Matches persona Stage-2 recovery semantic. |
| Atomic-rename strategy? | **Use existing `atomicWriteJson` (string signature) on the exporter side; skill writes via Bash `Write tmp; mv tmp final`** | The DN3-consolidated `atomicWriteJson` is the canonical primitive for in-process Node fs writes; the skill (in `claude -p` subprocess) gets equivalent tmp+rename via Bash. EBUSY-retry extension deferred to V1.1 if observed. CAS catches cross-endpoint races. |
| `candidateBudgetProxy` in V1? | **No — unreachable with `maxSessionsForCorpus=200`** | At 1 candidate/session × 200 sessions = 200 candidates/project ≪ 1200 proxy. Iter-4 audit caught this. V1.1 may add the gate once empirical per-project candidate counts justify it. |
| Fail-safe trade-off honesty | **V1 bypasses `effectivePriorForKernel` deliberately; cap is WEAKER not stronger** | Honesty about the trade-off: surface-with-cap (tier-2 reach) vs suppress-entirely (tier-0). V1 picks visibility; V1.1 re-evaluates. Disclosed in MethodologyDisclosure. |
| First-run-after-upgrade migration? | **Reader-side: `normalizeNarrativeRow()` defaults missing fields; no explicit migration command needed** | Users don't have to run anything; SCAN regenerates the stamped rows, and the surface stays correct in the meantime via the normalizer. |
| PII gitignore? | **Yes; relies on existing `apps/standalone/public/chat-arch-data/*` wildcard + explicit `narrative-candidates.json` line for auditable doc** | Same precedent as persona-candidates. |

---

## Review-loop cap-hit — unresolved items

The spec was iterated through 5 review-loop rounds (5 lens-agents per round + 1 falsifier per round). Iter counts of VERIFIED load-bearing findings: 11 → 12 → 10 → 9 → 2-3 (declining but never reaching 0). Per the loop's cap-hit rule, the following architectural decisions are surfaced explicitly as **open follow-up considerations** rather than silently shipped:

1. **Two-sidecar architectural alternative (iter-5 SIM finding, load-bearing).** Iter-5 simplicity review argued that splitting `narratives.json` (exporter-owned, heuristic only) + `llm-narratives.json` (skill-owned, single writer) eliminates `mergeNarrativeFamilies`, `classifyAttribution`, `buildNarrativesFileObject`, the CAS protocol, the `concurrent-rescan-aborted` skip status, and the tmp+rename concurrency story — collectively ~5 helpers + ~3 test files + the entire §"Concurrency model" section. The spec retained the single-file approach for V1 because (a) it matches existing `narratives.json` consumer wiring (single read site), (b) the merge contract + atomic-rename + CAS is well-defined as specified, (c) the architectural pivot at iter-5 cap would require respec-ing ~40% of the document. **The reviewer's point stands**: if the V1 implementation surfaces concurrency bugs that CAS can't catch — OR if implementing the merge helper proves harder than projected — the implementer should escalate before continuing, and the two-sidecar pivot is the V1.1 fallback design.

2. **V1 cap as visibility-vs-safety trade-off, not strengthening.** Iter-4 statistical-rigor caught the math-honesty error in an earlier draft ("the cap is strictly stronger than the uncalibrated-prior fail-safe"). The corrected framing is now in §"Skill template / Calibration fail-safe note": V1 deliberately surfaces LLM narratives at tier-2 (without the `uncalibratedPrior=20`-driven tier-0 suppression) because users seeing exploratory narratives is better than seeing none until calibration completes. This is a real safety-net weakening; disclosed in `MethodologyDisclosure`. V1.1 either accepts tier-0 suppression by wiring through `effectivePriorForKernel`, or keeps the bypass with a permanent disclaim.

3. **Within-bucket sub-sampling strategy** (iter-4 stat-rigor minor). The spec inherits "4-quartile stratified-by-recency" from `personaCandidates`, but the WITHIN-bucket strategy (random / first-N / last-N when a quartile has more sessions than its share) is documented in the persona implementation, not re-stated here. If the implementer pivots from `personaCandidates`'s within-bucket policy for any reason, the methodology-disclosure claim "bias is structurally closed" needs to be re-evaluated.

---

## Calibration plan (placeholders flagged in CHANGELOG `[1.7.0]`)

Pre-launch values that need empirical calibration once V1 has corpus data:

1. `THRESHOLDS.narrative.minSessionsForLlm = 20` — calibrate against hand-labeled narrative-usefulness ratings after first 10 personas + narratives co-emit. Track on the same 4-week rolling window as `CHATARCH_THRASH_DETECT`.
2. `THRESHOLDS.narrative.maxLlmUsdPerProject = 0.50` — recalibrate after observing actual Stage-2 USD per project across 10 runs; set to the 95th-percentile observed cost. `candidateBudgetProxy` deliberately omitted from V1 (unreachable as designed); V1.1 may add a per-recency-bucket candidate-count gate once empirical per-project candidate counts justify the bound.
3. `THRESHOLDS.narrative.minPerProject / maxPerProject = 3 / 8` — refit after hand-labeling 50 LLM narratives: if synthesis routinely produces 9+ useful narratives, raise the max; if it pads below 3, lower the min.
4. Confidence-ladder priors (`THRESHOLDS.narrativeRung.defaultPrior` interaction) — once 50 LLM narratives land, refit using the same calibration plan documented under `narrativeRung`. The plan there explicitly anticipates this: "Refit defaultPrior + per-kernel priors as Bayesian updates of the prior itself."
5. `THRESHOLDS.narrative.maxSessionsForCorpus = 200` — anchored to the bryce.md prototype's empirical existence proof (160-session author run). Not a free-tuning knob; refit only if the prototype's session count grows past 200 OR if calibration evidence shows the Stage-2 LLM ceiling on input handling has shifted. Treat as a load-bearing structural floor, not a placeholder.
6. `THRESHOLDS.narrative.evidenceMinPerNarrative = 2` — single-session "narratives" are anecdotes, not durable themes (iter-1 persona stat-rigor finding). Load-bearing structural floor aligned with `THRESHOLDS.narrativeRung.tier2SupportingMin = 2`; refit only in lockstep with the tier-2 supporting-count gate. NOT a free-tuning placeholder.
7. `THRESHOLDS.narrative.maxCandidatesPerRecencyBucket = 300` — per-bucket defensive ceiling. Currently unreachable under the upstream `maxSessionsForCorpus=200` sampler (which yields ≤50 candidates per bucket). The cap engages only when `maxSessionsForCorpus` is raised past 1200; until then this is a forward-compat guard for the per-bucket axis. Refit alongside `maxSessionsForCorpus` if the sampler ceiling moves.

**Calibration owners.** Bryce is the V1 calibration owner for all rows above; a future contributor may take a row by adding their name to a new "Owner" column. No-owner rows are revisited only on user-reported issue.

Each calibration value's history goes in `CHANGELOG.md` calibration notes alongside `composite.weights`, `persona.*`, and `curator.*`. The narrative-mining row in CHANGELOG `[1.7.0]` references this section.
