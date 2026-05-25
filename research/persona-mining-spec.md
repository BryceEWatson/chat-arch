# Persona mining — V1 spec

**Status:** spec only — no implementation. Awaiting Bryce's "act on the plan" before any code lands.

**Origin:** Bryce mined his own chat-arch sessions to author [`research/persona-evals/bryce.md`](persona-evals/bryce.md), found the result more useful than the original user-modeling pass, and requested automatic generation of equivalent personas for every project he uses Claude Code on.

**Decisions pinned (per design conversation 2026-05-25):**

1. **Scope:** per-project personas only — no cross-project composite in V1.
2. **Trigger:** on SCAN, as chain step 5 (after `/falsify`).
3. **UI surface:** new PERSONAS sidebar entry under WORKSHOP, alongside CORRECTIONS / PRACTICE / PLAYBOOK.

This doc covers what ships in V1, not the eventual maturity path. Cross-project composite, persona-drift detection, persona-aware skill argument substitution, and curator weighting against persona-derived preference vectors are all listed in the [Future surface] section.

---

## What V1 ships

Per project with ≥ `THRESHOLDS.persona.minSessionsForGeneration` (default 30) sessions in the corpus:

- One markdown persona at `apps/standalone/public/chat-arch-data/analysis/personas/<project-id>.md`
- Structured metadata in `apps/standalone/public/chat-arch-data/analysis/personas.json` (index + per-project record)
- A PERSONAS page rendering the markdown + cross-project nav (sidebar list)
- Wipe coverage: `personas/` family added to `/api/clear`

Projects below the session threshold get a skip-row in `personas.json` with reason `"insufficient-corpus"` — no thin personas emitted.

---

## File changes

### New files

| Path | Purpose |
|---|---|
| `.claude/skills/mine-persona/SKILL.md` | Skill driving the LLM synthesis stage |
| `.claude/skills/mine-persona/lib/extractor.ts` | Heuristic prompt-pattern extraction (pre-LLM stage) |
| `apps/standalone/src/pages/api/mine-persona.ts` | NDJSON-streaming endpoint, follows `mine-corrections.ts` template |
| `apps/standalone/src/pages/api/clear-personas.ts` | Selective wipe endpoint |
| `apps/standalone/src/pages/personas.astro` | New PERSONAS surface |
| `packages/schema/src/personas.ts` | `PersonasIndex`, `PersonaRecord`, `PersonaMetadata` types |
| `packages/exporter/src/analysis/personaCandidates.ts` | Per-project heuristic candidate extractor (writes `persona-candidates.json`) |
| `packages/exporter/test/integration/personaCandidates.test.ts` | Integration coverage |
| `research/persona-evals/<project-id>.md` (generated, NOT checked in) | Symlink target / mirror of `analysis/personas/<project-id>.md` for fresh-contributor visibility — TBD whether we actually need this mirror or whether the analysis dir is sufficient |

### Modified files

| Path | Change |
|---|---|
| `apps/standalone/src/scripts/fullScan.ts` | Add 5th entry to `FULL_SCAN_STEPS` for `/api/mine-persona` |
| `apps/standalone/test/scripts/fullScan.test.ts` | Update step count + header-pinning assertions to 5 |
| `apps/standalone/src/components/AppSidebar.astro` | Add PERSONAS link under WORKSHOP group |
| `apps/standalone/src/pages/api/clear.ts` | Extend orphan-sweep to `analysis/personas/` |
| `packages/analysis/src/thresholds.ts` | New `persona.minSessionsForGeneration` (default 30) + `persona.maxSessionsForCorpus` (cap on what gets fed to LLM, default 200, sample by recency) |
| `packages/exporter/src/analysis/index.ts` | Run `personaCandidates` as part of `runAnalysis` |
| `packages/exporter/src/analysis/EXPORTER_VERSION` | Bump 1.5.0 → 1.6.0 (new sidecar family) |
| `CHANGELOG.md` | `[1.6.0]` entry |
| `CLAUDE.md` | New entry under "Data on disk" describing the persona sidecar family + PII classification |

---

## Sidecar shapes

### `analysis/personas.json` — index

```json
{
  "schemaVersion": 1,
  "generatedAt": 1716673200000,
  "exporterVersion": "1.6.0",
  "thresholds": {
    "minSessionsForGeneration": 30,
    "maxSessionsForCorpus": 200
  },
  "personas": [
    {
      "projectId": "chat-arch",
      "projectName": "chat-arch",
      "sessionsAnalyzed": 160,
      "sessionsTotal": 627,
      "personaPath": "analysis/personas/chat-arch.md",
      "generatedAt": 1716673200000,
      "status": "generated"
    },
    {
      "projectId": "shopforge-v4",
      "projectName": "shopforge-v4",
      "sessionsAnalyzed": 0,
      "sessionsTotal": 12,
      "personaPath": null,
      "generatedAt": null,
      "status": "insufficient-corpus"
    }
  ]
}
```

### `analysis/personas/<project-id>.md` — content

Mirror the structure pioneered by `bryce.md`:

1. Header block (project name, sessions analyzed, time-span covered, "data-grounded from N sessions" disclaimer)
2. 6-10 numbered pattern sections, each with **Pattern.** / **Evidence.** (≥2 `[SID:...]`-cited quotes per section, verbatim) / **What this implies.**
3. Coverage notes (files sampled, false positives filtered, confidence assessment)
4. Optional "preserve / automate / get out of the way of" table — emit only when patterns are durable enough across time buckets

PII classification: **high.** Every persona file contains verbatim user prompt excerpts. Already covered by the existing `apps/standalone/public/chat-arch-data/*` gitignore wildcard; explicit `analysis/personas/` line added to `.gitignore` for auditable documentation.

### `analysis/persona-candidates.json` — intermediate

Heuristic extraction output (Stage 1, exporter-side, deterministic). Per-project records of:

- Prompt count by 6-category heuristic bucket (role/expertise prompts, preference statements, etc.)
- Top-N candidate prompts per category by length + uniqueness
- Time-bucket coverage (founding / mid / recent) so the LLM stage can verify durability

This sidecar is the input to `/mine-persona`. Skipping it directly to the LLM would re-do work every scan and lose the determinism of the heuristic layer.

---

## Skill template

`.claude/skills/mine-persona/SKILL.md` follows the existing `mine-corrections` skill structure:

- **Stage 1 (heuristic, pre-skill):** `personaCandidates.ts` runs as part of `runAnalysis`, writes `persona-candidates.json` with per-project candidate buckets.
- **Stage 2 (LLM, skill-driven):** `/mine-persona` reads `persona-candidates.json`, dispatches sub-agents per project (parallel, similar to the 4-agent dispatch used to author `bryce.md`), each sub-agent returns 6-section observations, parent synthesizes into final `<project-id>.md`.
- **Stage 3 (falsifier hookup):** existing `/falsify` skill is extended (separate follow-up PR) to verify persona evidence citations the same way it verifies finding evidence — every `[SID:...]` quote must be present in the cited session's actual messages.

LLM budget cap: `THRESHOLDS.persona.maxLlmUsdPerProject` (default $0.50). Skip projects when the cap would be exceeded; surface as `status: "budget-exceeded"` in the index.

---

## Chain integration

`FULL_SCAN_STEPS` becomes:

```ts
[
  { id: 'rescan',   label: 'rescan (exporter)',  url: '/api/rescan',           header: 'chat-arch-rescan' },
  { id: 'mine',     label: 'mine corrections',   url: '/api/mine-corrections', header: 'chat-arch-mine-corrections' },
  { id: 'curate',   label: 'curate feed',        url: '/api/curate',           header: 'chat-arch-curate' },
  { id: 'falsify',  label: 'falsify findings',   url: '/api/falsify',          header: 'chat-arch-falsify' },
  { id: 'persona',  label: 'mine personas',      url: '/api/mine-persona',     header: 'chat-arch-mine-persona' },
]
```

Failure semantics unchanged: persona failure halts the chain (no step 6 to run, so this is effectively the new chain terminus). The fullScan test gets a parallel header-pinning entry + the existing 4-step tests reused as 5-step.

REGEN BRIEF unchanged. The brief kernel could eventually pull a one-line persona summary, but that's a follow-up.

---

## UI surface — PERSONAS page

`apps/standalone/src/pages/personas.astro`:

- Sidebar list of all projects with personas, ordered by `sessionsAnalyzed` desc
- Skipped projects (insufficient-corpus / budget-exceeded) shown in a collapsed "not yet generated" section with the skip reason
- Selected project: renders its `.md` via the same MD-rendering path the brief uses
- Per-section drill-down to `[SID:...]` evidence: click an SID anchor → navigate to `/sessions#session/<sid>` (matches existing FEED card behavior)
- "REGEN PERSONA" per-project button (POSTs to `/api/mine-persona` with `{ projectId }`) — same affordance pattern as REGEN BRIEF

`AppSidebar.astro` change:

```
WORKSHOP
  PLAYBOOK
  CORRECTIONS
  PRACTICE
  PERSONAS   ← new
```

Short label / icon: `PER`. Match the existing 3-letter convention.

---

## Test plan

- **`personaCandidates.test.ts`** — fixture-driven; assert each of the 6 heuristic buckets fills correctly from a synthetic transcript with known prompt patterns.
- **`fullScan.test.ts` updates** — step count → 5, header pinning entry, all existing chain-semantics tests run as 5-step.
- **`mine-persona` skill integration test** — mock the `claude -p` spawn (per existing `mine-corrections` test pattern), assert `analysis/personas.json` + at least one `<project-id>.md` write.
- **Manual end-to-end** — click SCAN, verify 5 POSTs in dev server log, verify `analysis/personas/chat-arch.md` appears on disk, verify PERSONAS sidebar entry renders the generated markdown.

---

## Out of scope (V1)

Listed here so a future spec can pull from a known menu:

- **Cross-project composite persona** ("who is the user across all repos"). Adds 1 more LLM call regardless of project count; saves seeing context-switch costs across projects.
- **Persona-drift detection** — diff successive scans' personas; surface when a section's evidence quotes turn over rapidly (signal of changing working style).
- **Curator weighting by persona-derived preference vector** — current curator ranks findings by composite outcome + tier; could additionally weight by alignment with persona patterns (e.g., findings that match "specification-as-prompt" preference rank higher).
- **Persona-aware skill argument substitution** — when invoking a skill, auto-supply persona patterns as context ("the user prefers X / dislikes Y").
- **Hosted-demo persona generation** — the `chat-arch.dev` static deploy has no LLM access, so personas are local-only in V1. Demo bundle could ship a sample persona for the demo project, but that's a demo-data PR.

---

## Estimated PR shape

Single bundled PR per `feedback_claude_code_paced_prs` (Claude-Code-paced, not human-paced):

- Wave 1: schema + thresholds + exporter heuristic + sidecar producers + tests
- Wave 2: skill + API endpoint + chain integration + clear-personas
- Wave 3: viewer surface + sidebar + e2e wiring
- Wave 4: docs (CHANGELOG, CLAUDE.md, exporter version bump) + manual verification

Rough size: ~15-25 files, mostly new, ~1500-2500 LOC including tests. Should comfortably fit one PR with sub-agent fan-out per wave.

---

## Decision log

| Question | Decision | Rationale |
|---|---|---|
| Per-project, composite, or both? | **Per-project only** | Composite costs 2N LLM calls; defer to V2 once we know V1 lands. |
| When to trigger? | **On SCAN as chain step 5** | Matches existing chain discipline; always-fresh personas without manual button-pressing. |
| Where to surface? | **New PERSONAS sidebar entry** | First-class discoverability; matches CORRECTIONS / PRACTICE / PLAYBOOK pattern. |
| LLM budget? | **$0.50/project default, skip on overage** | Personas should never become a surprise cost. |
| Min sessions to generate? | **30, configurable via threshold** | Below 30 sessions, patterns aren't durable enough to be useful (this number is itself a placeholder — calibrate after first run). |
| PII gitignore? | **Yes, explicit `analysis/personas/` line** | Already covered by wildcard, but explicit line is auditable documentation per existing precedent. |
