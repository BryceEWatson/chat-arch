# Continuation prompt — persona-mining feature implementation

Paste the body below into a fresh Claude Code session running in `c:\Users\Bryce\Projects\chat-arch`. The prompt is self-contained and assumes zero context from the session that drafted it.

---

# Implement chat-arch persona-mining feature (V1)

## Why you're here

Bryce hand-authored `research/persona-evals/bryce.md` by mining his own chat-arch session history across 4 time buckets via parallel sub-agents, and found the data-grounded persona substantially more useful than the original hypothetical-user personas (`maya.md`, `david.md`, `priya.md`, `sam.md`). He wants chat-arch to generate equivalent personas **automatically, per project, on every SCAN**. The spec is pinned. Your job is to ship it end-to-end in one bundled PR.

## Read first

**Spec (load-bearing — read fully before doing anything else):**
- [`research/persona-mining-spec.md`](research/persona-mining-spec.md) — V1 spec with decisions pinned (per-project only, on-SCAN as chain step 5, new PERSONAS sidebar entry). Includes file-changes table, sidecar shapes, skill template, chain integration, UI surface, test plan, decision log.

**Reference artifacts (the persona this work is modeled on):**
- [`research/persona-evals/bryce.md`](research/persona-evals/bryce.md) — the hand-authored canonical that auto-gen should match in quality. Mirror this structure (header / 6-10 numbered pattern sections with **Pattern.** / **Evidence.** / **What this implies.** / coverage notes / optional preserve-automate-get-out-of-the-way table).
- [`research/persona-evals/README.md`](research/persona-evals/README.md) — names bryce.md as primary user-modeling persona; the 4 onramp-eval personas (maya/david/priya/sam) are secondary. Auto-generated personas live under `analysis/personas/<project-id>.md` and do NOT supersede the hand-authored `bryce.md` (which stays as the canonical for the chat-arch project specifically).

**Existing patterns to mirror (DO NOT invent new infrastructure):**
- [`apps/standalone/src/pages/api/mine-corrections.ts`](apps/standalone/src/pages/api/mine-corrections.ts) — NDJSON-streaming endpoint template. `/api/mine-persona` should follow this shape exactly: CSRF gate (Origin + X-Requested-With), `inFlight` serializer, parseParams + auto-window pattern, spawn `claude -p`, emit NDJSON `start` / `phase` / `stdout` / `done` events.
- [`.claude/skills/mine-corrections/`](.claude/skills/mine-corrections/) — skill structure. Build `.claude/skills/mine-persona/` parallel to it (SKILL.md + lib/).
- [`apps/standalone/src/scripts/fullScan.ts`](apps/standalone/src/scripts/fullScan.ts) — chain orchestrator. Add 5th entry to `FULL_SCAN_STEPS`; update the corresponding test in [`apps/standalone/test/scripts/fullScan.test.ts`](apps/standalone/test/scripts/fullScan.test.ts).
- [`packages/exporter/src/analysis/semanticAnalysis.ts`](packages/exporter/src/analysis/semanticAnalysis.ts) — exporter producer template. The heuristic candidate extractor (Stage 1, deterministic) lands in `packages/exporter/src/analysis/personaCandidates.ts` and is wired into `runAnalysis`.

## State reconciliation — DO THIS FIRST

Before any work, run state reconciliation per [`feedback_state_reconciliation`](C:\Users\Bryce\.claude\projects\c--Users-Bryce-Projects-chat-arch\memory\feedback_state_reconciliation.md):

1. `git status` — current branch + uncommitted files
2. `gh pr list --state open --json number,title,headRefName` — what PRs are open
3. `gh pr view 105 --json state,statusCheckRollup -q '.state + " | checks: " + (.statusCheckRollup[0].state // "pending")'` — status of in-flight bug-fix PR

**Expected state when this prompt fires:**
- PR #105 (`fix/auto-brief-and-scan-wiring`) is the in-flight bug-fix PR — may be still open with pending checks, or already merged. **Do NOT add feature work to that branch under any circumstances.**
- Three unstaged research files may exist on the current branch outside PR #105's scope:
  - `research/persona-evals/bryce.md`
  - `research/persona-evals/README.md`
  - `research/persona-mining-spec.md`
- These were authored alongside #105 but are not part of its diff.

**Branch hygiene decision tree:**

- **If #105 is already merged into main** → branch off main: `git switch main && git pull && git switch -c feature/persona-mining`. Stage the 3 research files (they're now in your worktree from main if #105 included them — verify with `git ls-files research/persona-evals/`; if not, you'll need to recover them from the previous branch via `git show <prev-branch>:<path>`).
- **If #105 is still open** → branch off main: `git switch main && git switch -c feature/persona-mining`. Recover the 3 unstaged research files from the `fix/auto-brief-and-scan-wiring` branch: `git show fix/auto-brief-and-scan-wiring:research/persona-evals/bryce.md > research/persona-evals/bryce.md` (etc. for the other two).

**NEVER** force-push or use `git switch --discard-changes` (per [`feedback_git_switch_discard`](C:\Users\Bryce\.claude\projects\c--Users-Bryce-Projects-chat-arch\memory\feedback_git_switch_discard.md)). Use targeted stash + show.

## Implementation plan — 4 waves with sub-agent fan-out

Per [`feedback_claude_code_paced_prs`](C:\Users\Bryce\.claude\projects\c--Users-Bryce-Projects-chat-arch\memory\feedback_claude_code_paced_prs.md): Claude-Code-paced work bundles into 1-2 PRs with sub-agent fan-out per wave. Ship as ONE PR.

### Wave 1 — schema + thresholds + heuristic extractor (deterministic layer)

Sub-agent A:
- Create `packages/schema/src/personas.ts` with `PersonasIndex`, `PersonaRecord`, `PersonaMetadata` types per spec § Sidecar shapes
- Wire export through `packages/schema/src/index.ts`

Sub-agent B:
- Extend `packages/analysis/src/thresholds.ts` with `persona.minSessionsForGeneration` (default 30), `persona.maxSessionsForCorpus` (default 200), `persona.maxLlmUsdPerProject` (default 0.50)
- Add THRESHOLDS test coverage for new fields

Sub-agent C:
- Create `packages/exporter/src/analysis/personaCandidates.ts` — heuristic extractor that per-project reads the SQLite substrate via `@chat-arch/exporter/db`, samples up to `maxSessionsForCorpus` recent prompts, classifies into 6 heuristic buckets (role/expertise, preferences, project-specific use, working rhythm, frictions, voice), writes `analysis/persona-candidates.json`
- Wire into `runAnalysis` in `packages/exporter/src/analysis/index.ts`
- Add `analysis/persona-candidates.json` + `analysis/personas.json` to meta.tiers.browser.files
- Bump `EXPORTER_VERSION` 1.5.0 → 1.6.0 in `packages/exporter/src/analysis/index.ts`

Sub-agent D:
- Write `packages/exporter/test/integration/personaCandidates.test.ts` — fixture-driven, assert 6 buckets fill from a synthetic transcript

**Wave 1 exit gate:** `pnpm lint && pnpm test && pnpm build` clean. 2154+ baseline pass count.

### Wave 2 — skill + API endpoint + chain integration

Sub-agent A:
- Build `.claude/skills/mine-persona/SKILL.md` modeled on `.claude/skills/mine-corrections/SKILL.md`. The skill consumes `persona-candidates.json`, dispatches per-project sub-agents that mirror the 4-bucket-by-recency strategy used to author `bryce.md`, synthesizes into `analysis/personas/<project-id>.md`.
- Add `.claude/skills/mine-persona/lib/` helpers as needed for prompt construction.

Sub-agent B:
- Create `apps/standalone/src/pages/api/mine-persona.ts` following `mine-corrections.ts` template line-for-line: CSRF (REQUIRED_HEADER = `chat-arch-mine-persona`), inFlight, parseParams, spawn `claude -p` invoking the skill, NDJSON stream.
- Create `apps/standalone/src/pages/api/clear-personas.ts` — selective wipe for `analysis/personas/` family

Sub-agent C:
- Update `apps/standalone/src/scripts/fullScan.ts`: append 5th entry to `FULL_SCAN_STEPS` `{ id: 'persona', label: 'mine personas', url: '/api/mine-persona', header: 'chat-arch-mine-persona' }`
- Update `apps/standalone/test/scripts/fullScan.test.ts`: header-pinning entry + all chain-semantics tests run as 5-step
- Update `apps/standalone/src/pages/api/clear.ts` to extend orphan-sweep to `analysis/personas/`

**Wave 2 exit gate:** lint + test + build clean. Chain test confirms 5-step variant works.

### Wave 3 — viewer surface (PERSONAS page + sidebar)

Sub-agent A:
- Create `apps/standalone/src/pages/personas.astro` per spec § UI surface — PERSONAS page
- Sidebar list of all projects with personas, ordered by `sessionsAnalyzed` desc
- Skipped projects shown in collapsed "not yet generated" section with reason
- Selected project: render its `.md` via the same MD-rendering path the brief uses (grep for how `/api/regen-brief` / TODAY page renders the brief — reuse that path)
- Per-section drill-down: click `[SID:...]` anchor → navigate to `/sessions#session/<sid>` (matches existing FEED card behavior — verify HASH_SESSION_PREFIX in `packages/viewer/src/ChatArchViewer.tsx`)
- "REGEN PERSONA" per-project button: POSTs `/api/mine-persona` with `{ projectId }`

Sub-agent B:
- Update `apps/standalone/src/components/AppSidebar.astro`: add PERSONAS entry under WORKSHOP group, short label `PER`. Match existing 3-letter convention (PLB / COR / PRC).
- Update sidebar test `apps/standalone/test/components/AppSidebar.test.ts` accordingly

**Wave 3 exit gate:** lint + test + build clean. Manual: PERSONAS sidebar entry visible, page renders, "not yet generated" projects shown.

### Wave 4 — docs + manual verification

Single agent (no fan-out needed):

- Update `CHANGELOG.md` with `[1.6.0]` entry covering the persona feature
- Update `CLAUDE.md` "Data on disk" section: new entry for `analysis/personas/` family + PII classification (high — verbatim user-prompt excerpts)
- Update `.gitignore`: explicit `analysis/personas/` line (already covered by wildcard, but explicit line is auditable documentation per existing precedent)
- Update CLAUDE.md "Shape of the workspace" section if a new top-level dir was added
- Add a brief "Persona mining" subsection to README.md if appropriate

**Wave 4 exit gate:** `pnpm lint && pnpm test && pnpm build` clean. Manual: click SCAN → verify 5 POSTs in dev server log → verify `analysis/personas/chat-arch.md` appears on disk → verify PERSONAS sidebar entry renders the generated markdown for chat-arch project.

## Test gates (per project CLAUDE.md)

Before opening the PR:
- `pnpm lint` — clean (max 1 pre-existing warning in `apply-correction.ts`; no new warnings)
- `pnpm test` — clean (2154+ pass / 5 skipped baseline)
- `pnpm build` — clean
- Manual: SCAN button on TODAY → 5 POSTs in dev server log: `/api/rescan` → `/api/mine-corrections` → `/api/curate` → `/api/falsify` → `/api/mine-persona`
- Manual: `analysis/personas/chat-arch.md` exists on disk after SCAN
- Manual: PERSONAS sidebar entry renders the generated persona

If the auto-generated chat-arch persona quality is < 70% of `bryce.md`'s, surface that in the PR description as a known V1 limitation — do NOT block on perfecting the synthesis prompt (that's V2 calibration work).

## Project conventions (reminders, per chat-arch CLAUDE.md)

**Staging:**
- NEVER `git add -A` / `.` — stage by explicit path
- `apps/standalone/public/chat-arch-data/manifest.json` is local PII — leave unstaged
- `analysis/personas/*.md` files are PII — they should be gitignored (and they are, by the wildcard), but never stage them explicitly even by mistake

**Git workflow:**
- Branch off main + PR, never push to main
- `gh pr create` after `git push -u origin feature/persona-mining`
- Squash-merge default
- Bryce merges his own PRs unless he says otherwise — open the PR, surface CI status, do NOT merge

**Out of scope (V1) — do NOT do these:**
- Cross-project composite persona
- Persona-drift detection (diffing successive scans)
- Curator weighting by persona-derived preference vector
- Persona-aware skill argument substitution
- Falsifier extension to verify persona evidence citations (Stage-3 follow-up per spec)
- Replacing the hand-authored `research/persona-evals/bryce.md` with auto-generated output (the hand-authored stays as canonical for the chat-arch project specifically — auto-gen lives at `analysis/personas/chat-arch.md` separately)

Each of the above is listed in `research/persona-mining-spec.md` § "Out of scope (V1)". If you find yourself wanting to do any of them, stop and surface as a follow-up note in the PR description.

## When done

1. Open the PR via `gh pr create` with title `feat(persona-mining): per-project persona auto-generation as SCAN chain step 5`
2. PR description: summary, decisions pinned (cite spec), waves shipped, test plan checked off, known limitations (V1 quality calibration TBD)
3. Surface CI status. Do not merge.
4. Report back with the PR URL.

## Estimated complexity

~15-25 files, mostly new, ~1500-2500 LOC including tests. Single bundled PR. If any wave exit-gate fails repeatedly, stop and ask Bryce — do not silently scope-cut.
