# chat-arch v2 — Locked Specification

**Status:** Locked late April 2026, restored May 5 2026.
**Visual language source of truth:** Supergraphic Panel design system at `design-system/spec.md`. v2 references and uses it; does not redefine palette, typography, or component vocabulary. Only the elbow geometry changes (see §10).

---

## 1. What chat-arch v2 is

A personal intelligence platform built on a unified Claude conversation archive across four sources: claude.ai cloud, Claude Code CLI, Claude Desktop, and Claude Cowork. Output is narrative-driven analysis serving three goals:

1. Improving the projects the user works on.
2. Selling the user's skills with evidence.
3. Refining how the user works with AI overall.

**Central thesis:** past sessions can be mined to produce artifacts that improve future sessions.

## 2. Repo shape

pnpm workspace, "Shape B":
- `packages/schema` — entities, types, validation
- `packages/exporter` — ingestion, unified archive build, CLI
- `packages/analysis` — browser-safe shared analysis kernel (consumed by viewer + exporter)
- `packages/viewer` — React UI components
- `apps/standalone` — Astro shell

Playwright visual testing across surfaces × states × viewport tiers.

## 3. Two-tier architecture

- **Browser-tier:** limited functionality. Reads cloud export only. No filesystem.
- **Local-tier:** full functionality. Reads cloud + Code CLI + Desktop + Cowork. Runs heavy analysis. Has filesystem access for repo-grounding.

Local-only features in browser-tier render as **disabled-with-explanation**, not hidden.

## 4. Two organizing entities

### 4.1 Project (first-class entity)

Narrative-bearing. **Discovery-only** — no manual creation. Emerges from analysis. Each project has narratives attached.

Fields: `id` (stable hash, NOT display name), `displayName`, `discoveredAt`, `lastActivityAt`, `sessionIds[]`, `narrativeIds[]`, `topicIds[]`, `sentiment` (rolled up from narratives), `source` (which discovery rule emitted it).

### 4.2 Topic (first-class entity)

Universal lightweight label. Applied across all sessions, including orphaned ones via the `[UNASSIGNED]` pseudo-project.

Fields: `id`, `displayName`, `sessionIds[]`, `projectIds[]`, `firstSeenAt`, `lastSeenAt`.

### 4.3 `[UNASSIGNED]` pseudo-project

A reserved project entity (`id: "__unassigned__"`) representing sessions not assigned to any discovered project. Bears topics but does NOT bear narratives. It is a parking lot, not a real project.

### 4.4 Narrative (first-class entity)

The unit of insight. Sentiment-aware.

Fields: `id`, `projectId`, `sessionIds[]`, `sentiment` (`positive` | `negative` | `neutral`), `title`, `body`, `evidence[]` (session deep-link refs), `generatedAt`, `actionType` (`encode-as-pattern` for positive, `generate-corrective-prompt` for negative).

## 5. Seven-surface IA

**Amended 2026-05-23** (outcome-substrate roadmap, plan §0). The
original April-2026 lock specified four top-level surfaces (PROJECTS
/ TOPICS / SESSIONS / PRACTICE). That decision is extended: three
additional session-graded modes get top-level homes — **Effectiveness**,
**Insights**, **Decisions** — and three cross-cutting analyses
(**Trust**, **Trends**, **Export**) attach to PRACTICE as lenses.
Rationale and surface definitions live in
[chat-arch-v2-rev3-plan.md](chat-arch-v2-rev3-plan.md) §0 and the
PR #53 commits that shipped them.

The four original surfaces (§§5.1–5.4 below) are unchanged. The new
top-level modes (§§5.5–5.7) ship a `MethodologyDisclosure` panel +
cell-level `SourceAttribution` honesty labels at every claim site.

### 5.1 PROJECTS — index + detail

Most complex surface. Index lists discovered projects (incl. `[UNASSIGNED]`) with counts, sentiment summary, last activity. Detail page is single-scroll: narrative cards at top → session list below → topic chips throughout.

### 5.2 TOPICS — index + detail

Index lists topics with session counts and projects-per-topic. Detail is a side panel or page with sessions matching the topic, cross-linked to projects.

### 5.3 SESSIONS — preserves v1 layout, adds v2 metadata

Existing v1 grid preserved. Each session card adds: project chip, topic chip, narrative-attachment chip (if narratives reference this session), inline flag indicators, deep-link anchors.

### 5.4 PRACTICE — adversarial audit dashboard

Four lenses, single audit pass with four output sections:

1. **Your patterns** — how the user works (recurring approaches, decision shapes).
2. **Agent patterns** — how Claude responds to the user (modes, failures, helpful behaviors).
3. **Process gaps** — what's missing in the workflow (skipped verification, missing artifacts).
4. **Value leaks** — where time/effort/cost is being lost (zombie sessions, duplicates, runaway loops, cost outliers).

The four lenses share inputs: sessions, projects, narratives, the existing zombies/duplicates/cluster outputs from `packages/analysis`, and the cost data from the unified schema.

PRACTICE additionally hosts three lenses added by the outcome-substrate
roadmap (PR #53), each backed by its own analysis sidecar:

5. **Trust** — pairwise `(source, archetype)` comparison via
   Holm-Bonferroni (`surface-comparison.json`).
6. **Trends** — per-project trajectory (Theil-Sen + block-bootstrap CI;
   `project-trajectories.json`) + skill-curve trends (Mann-Kendall +
   BH-FDR; `skill-curves.json`).
7. **Export** — Obsidian-targeted markdown export (post-mortems +
   knowledge-debt; `chat-arch-data/exports/`).

### 5.5 EFFECTIVENESS — composite-outcome dashboard

Per-session composite score + binary good/bad classification (from
`composite-outcomes.json`), surfaced as a time-series and a session-
level table. Reads `THRESHOLDS.composite.weights`. The
`MethodologyDisclosure` panel names the eight signal sources
(test-pass / test-fail / build-pass / pr-merged / pr-closed-unmerged /
rework-same-session / rework-continuation / affirmation) and the
calibration plan.

### 5.6 INSIGHTS — interrupted-time-series contrasts

Renders the contrast of composite score in a window around each
`.claude/` config change (`its-analysis.json`). Each row is a
config-commit family; methodology disclosure flags multiple-testing
caveats (BH-FDR landing in a follow-up per Rev3 review T1).

### 5.7 DECISIONS — extracted decisions joined to outcome

Decisions detected in your archive (`decisions.json`), grouped by
kind, with landed-rate (composite-outcome share) per decision class.
Rows hidden when n < `THRESHOLDS.display.minNForRate` (Wilson 95% CI
too wide to be informative). MINE button shells the v1-stub mine-
decisions skill — visibly labeled STUB until Phase Rev3-F lands the
real curator/falsifier pipeline.

## 6. Navigation chrome

- **Left sidebar = primary nav.**
- **Top header = informational chrome only.** Tier indicator, current location indicator (PROJECTS / TOPICS / SESSIONS / PRACTICE / EFFECTIVENESS / INSIGHTS / DECISIONS — see §5 amendment), EARTHDATE-style date chip, search input. NO action buttons in the header.
- **No nav duplication** between sidebar and header.

Data-source actions (UPLOAD CLOUD, SCAN LOCAL, DELETE ALL) live under a new "DATA" item in the sidebar that opens a panel. They are NOT in the header.

## 7. Narrative card anatomy

Sentiment-aware:
- **Positive narratives** → "encode as pattern" action.
- **Negative narratives** → "generate corrective prompt" action.

Card shows: sentiment indicator, title, body, evidence pills (linking to sessions), action button.

## 8. Corrective prompt flow (negative narrative action)

Three steps:

1. **Scope confirmation** — user confirms which narrative + which target repo (if multiple).
2. **Prompt review** — generated prompt rendered with edit affordance. Grounded in current repo state via `git status` + `git diff` + named-file content read at generation time. Stale snapshots are explicitly rejected.
3. **Handoff** — saves prompt to `_planning/prompts/{narrative-id}.md` AND copies to clipboard. User then pastes into a fresh Claude Code session.

**Validation failure handling:** if repo state can't be grounded (no git, detached HEAD, files referenced in narrative missing), the flow surfaces a clear error and does not generate a stale prompt.

**Tier:** local-tier only. Browser-tier shows disabled-with-explanation.

## 9. Encode-as-pattern flow (positive narrative action)

Persists the pattern to:
1. **Always:** sidecar `analysis/patterns.json` (machine-readable, for future analysis input).
2. **Optionally on user confirm:** appended to project `CLAUDE.md` (human-readable, for the next Claude Code session in that project's repo).

**Tier:** local-tier for `CLAUDE.md` append; sidecar works on both tiers.

## 10. LCARS chrome (visual)

- **Single L-shape** with quarter-circle inner-radius elbow. NOT two rectangles butted together at a square inner corner (the v1 geometry).
- **Left-edge-only frame.** No top arm. No four-sided wrapper.
- Implementation: SVG path or `clip-path: polygon()` (single chrome element). NOT separate rectangle elements.
- Update `design-system/spec.md` to document the v2 geometry.

## 11. Required states (per surface)

Every surface ships with designed and wired:

- **Empty** — no data yet, or no discovery results yet.
- **Loading** — skeleton placeholder matching the surface's chrome.
- **Error** — validation-failed (manifest schema mismatch), repo-disconnected (corrective-prompt flow can't ground).
- **Browser-tier-restricted** — local-only feature accessed in browser tier; disabled-with-explanation per §3.

## 12. v1 mode disposition (locked decisions)

- **TIMELINE** → absorbed into SESSIONS as a sort/view toggle. Not a top-level surface.
- **CONSTELLATION** (duplicates, zombies, clusters) → its outputs feed PRACTICE → "value leaks" lens. The standalone CONSTELLATION mode is retired from primary nav; the analysis kernel that produces its outputs is preserved as input to PRACTICE.
- **COST** → absorbed into PRACTICE → "value leaks" lens AND a per-project cost panel in PROJECTS detail. Standalone COST mode retired from primary nav.

## 13. Schema persistence

**Amended 2026-05-22** (chat-arch v2 Rev 3, plan §0). The original April-2026 lock specified per-entity sidecar JSON files in the manifest's analysis directory. That decision is superseded: substrate becomes SQLite (`better-sqlite3` + `sqlite-vec` for embeddings + FTS5 for text search). Rationale and implementation contract live in [_planning/chat-arch-v2-rev3-plan.md](chat-arch-v2-rev3-plan.md) §"SQLite write contract" and §"Zero-data start (no migration)".

Substrate shape:

- A single SQLite database file co-located with the existing `chat-arch-data/` directory (`*.db` + WAL/SHM siblings, all gitignored).
- First-class entities (Project, Topic, Narrative, Pattern, Session, SessionMessage, SessionRevision) live in dedicated typed tables. Kernel-specific outputs land in a generic `findings(kernel, payloadJson, ...)` table for open shapes.
- A `schema_migrations` table versions the schema; each Rev 3 phase ships an idempotent migration.
- An `analyzers` registry table holds per-kernel metadata (`name`, `version`, `lastRunAt`, `calibrationCompletedAt`, `prior`).
- WAL mode + `synchronous=NORMAL`. Single-writer-per-process via `BEGIN IMMEDIATE` with documented backoff on `SQLITE_BUSY`.

**Zero-data start.** No migration kernel. The pre-existing ~27 JSON sidecars under `apps/standalone/public/chat-arch-data/analysis/` are orphaned and ignored by the new code path. Users re-run SCAN LOCAL to populate the new database from source transcripts. The existing "NO DATA YET" landing screen handles the empty-DB initial state. `NuclearReset` is extended to sweep the orphan JSON directory alongside its IndexedDB clears.

TypeScript types in `packages/schema/src/` remain the contract — they describe rows now instead of JSON sidecar shapes. The flat string fields `project` and `topic` on `UnifiedSessionEntry` are preserved for display, treated as derived values from the typed row references.

Hosted-viewer divergence: `chat-arch.dev` stays on the original JSON-sidecar path as a deliberately-scoped demo of the local pipeline. Only the local-tier substrate moves to SQLite.

## 14. Surface routing

Each top-level surface gets its own Astro route:
- `/` → redirect to `/projects` if data present, else landing
- `/projects` → PROJECTS index
- `/projects/[id]` → PROJECTS detail
- `/topics` → TOPICS index
- `/topics/[id]` → TOPICS detail
- `/sessions` → SESSIONS grid (preserves v1)
- `/sessions/[id]` → session detail
- `/practice` → PRACTICE four-lens dashboard

The React viewer mounts as an island per route. Deep links work natively.

## 15. Sentiment classification (locked)

Rule-based heuristic for v2.0:
- **Positive markers:** "worked", "shipped", "tests pass", "deploy succeeded", "merged", explicit user affirmation patterns.
- **Negative markers:** "doesn't work", "broken", "failed", "stuck", repeated retries on same task, abandonment patterns (session ends without resolution).
- **Neutral default** when neither dominates.

LLM-based sentiment is descoped to v2.1.

## 16. Out of scope for v2

**Amended 2026-05-22** (chat-arch v2 Rev 3, plan §0). The original April-2026 lock descoped the "autonomous Claude Code orchestrator with subagent delegation" pattern to v2.1+. That decision is superseded: the curator + falsifier + MCP server land as part of this build. Phases Rev3-F (curator/falsifier) and Rev3-H (MCP) in [_planning/chat-arch-v2-rev3-plan.md](chat-arch-v2-rev3-plan.md) are in-scope deliverables, not v2.1 punts.

Scope clarifications (in v2):

- Curator agent + falsifier agent, both driven via the existing `resolveClaude.ts` subprocess pattern (`claude -p` plan-usage billing; API-key fallback OFF by default).
- Standalone MCP server exposing the data SDK as tools to external claude sessions. Read-only by default; narrow tool surface; localhost-bind only in v2.0.

Still out of scope (in v2):

- Mobile-app native client.
- Multi-provider support.
- Server-side persistence / multi-user.
- Telemetry / analytics beacons.
- LLM-based narrative or sentiment generation.
- Removing `packages/analysis`.
- Removing the demo path.
- **Remote MCP-over-HTTP.** Phase Rev3-H ships localhost-bind only; remote is a separate amendment if ever.

---

*End of v2 spec.*
