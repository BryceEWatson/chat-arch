# Project Identity v2 — one-time sweep runbook

The v2 cascade re-keys projects (302 → ~34; the haiku-VM singletons collapse,
scheduled tasks become `proj_routine-*`, `proj_outputs` disappears). Adoption is
just the next normal rescan — `projects.json` / `topics.json` / `narratives.json`
heuristic rows and the kernel-built sidecars (`project-trajectories.json`,
`archetypes.json`, `surprises.json`, …) are **rebuilt fresh every rescan and
self-heal**, so most of the corpus needs no manual intervention.

Four artifacts are **skill-written and persist across rescans**, so they retain
stale project-id references until re-mined. Sweep them **once** after the first
v2 rescan, then re-mine:

| Artifact | Why it's stale | How to clear |
|---|---|---|
| `analysis/personas/<old-id>.md` + `personas.json` | per-project markdown keyed to vanished ids | `POST /api/clear-personas` |
| `analysis/narratives.json` (LLM-derived rows) | `attributedTo:'llm-derived'` rows keyed to vanished project ids | `POST /api/clear-narratives` (preserves heuristic rows) |
| `analysis/curator-feed.json` | written by `/curate`; embeds project ids + previews | delete the file (regenerated on next `/curate`) |
| `analysis/falsifier-verdicts.json` | written by `/falsify`; references finding ids | delete the file (regenerated on next `/falsify`) |

## Procedure (local dev only)

```bash
# 0. PREVIEW FIRST (non-destructive) — review the new bucketing before adopting.
#    Writes analysis/project-identity-preview.json; touches no live artifact.
pnpm exporter run start --no-cloud --project-identity-preview
#    (or the equivalent: node packages/exporter/dist/cli.js all --project-identity-preview)
#    Inspect analysis/project-identity-preview.json: summary (projects/UNASSIGNED/
#    moved), resolvedViaCounts, unassignedReasons. If the bucketing looks wrong,
#    do NOT proceed — adjust projectOverrides.json or stop.

# 1. ADOPT — a normal rescan rebuilds projects.json under the v2 cascade.
#    (The viewer RESCAN button does the same; the EXPORTER_VERSION 1.9.0 bump
#    invalidates the cli/cowork caches so the new scheduledTaskId/sessionType
#    fields repopulate.)

# 2. SWEEP the four skill-written artifacts (curl from the running dev server,
#    or use the viewer affordances):
curl -X POST localhost:4321/api/clear-personas   -H 'X-Requested-With: chat-arch-clear-personas'
curl -X POST localhost:4321/api/clear-narratives -H 'X-Requested-With: chat-arch-clear-narratives'
rm -f apps/standalone/public/chat-arch-data/analysis/curator-feed.json
rm -f apps/standalone/public/chat-arch-data/analysis/falsifier-verdicts.json

# 3. RE-MINE: re-run /mine-persona, /mine-narratives, /curate, /falsify so the
#    swept artifacts regenerate against the new project ids.

# 4. AUDIT — confirm the v2 targets held:
node scripts/audit-project-identity.mjs
```

## Manual overrides (`projectOverrides.json`)

Irreducible cases (e.g. the `brycewatson.com` 3-cwd collision, or a basename
over-merge) are fixed by appending to
`apps/standalone/public/chat-arch-data/projectOverrides.json` — either via the
viewer's **"Move to project"** affordance (writes a `sessionIds` row) or by hand:

```json
[
  { "projectId": "brycewatson-com", "displayName": "brycewatson.com",
    "match": { "cwdGlob": "**/Projects/brycewatson.com/**" } },
  { "projectId": "client-a-docs", "match": { "sessionIds": ["<uuid>", "<uuid>"] } }
]
```

`projectId` is a **raw key** (NOT `proj_`-prefixed — the cascade's
`stableProjectId` normalizes it). Overrides are cascade **rule 0** (confidence
1.00) — they win over every other signal. The file is gitignored (it carries
session ids / cwd globs — PII).
