# chat-arch — project notes for Claude

Supplements the global `~/.claude/CLAUDE.md`. Project-specific rules
live here; conflicts resolve in favor of this file.

## Git workflow — ALWAYS use pull requests

**CI is expensive.** The workflow in `.github/workflows/ci.yml` runs
`pnpm install --frozen-lockfile` + `pnpm lint` + `pnpm test` +
`pnpm build` on every trigger, which takes several minutes on a full
monorepo with ~900 packages in the pnpm graph.

Therefore:

1. **Never push directly to `main`.** Push your work to a feature
   branch (`feature/<description>` convention) and open a PR — even
   for small changes.
2. **One CI run per change, not two.** The CI workflow is configured
   to run on both `push: main` and `pull_request:` — if you direct-
   push and also open a PR, you pay for two runs on the same commit.
   Branch-then-PR pays once (the PR run; the post-merge main run is
   the merge commit, a different tree).
3. **Don't force-push to shared branches.** `main` and any branch
   the user has opened a PR on are off-limits to force-push.
4. **Use `gh pr create` after `git push -u origin <branch>`** and
   return the PR URL so the user can jump straight to review.
5. **Squash merge is the project default** (matches the global
   CLAUDE.md convention). The PR-review protocol in the global file
   still applies — verify build/lint/tests pass locally before
   opening.

If you think a change is too small to warrant a PR, ask the user
before direct-pushing. The default answer is "no, still PR it."

## Staging discipline — NEVER `git add -A` / `.` in this repo

`apps/standalone/public/chat-arch-data/manifest.json` is tracked in
its empty baseline form (schemaVersion + zeroed counts + empty
sessions array) but gets *populated on disk* by `pnpm exporter run
start` / the in-app SCAN LOCAL action. The populated content
includes session titles, message previews, per-session USD costs,
and workflow metadata — PII for the developer running the tool.

A staging mistake (`git add -A`, `git add .`, or any pattern that
auto-stages all modified files) can sweep the populated manifest
into a commit. This has already happened once; do not let it happen
again.

Rules:

1. **Stage files by explicit path.** `git add path/to/file.ts`,
   never `-A` / `.` / `--all`. The `.claude/settings.json` here
   denies those patterns at the harness layer; the `.githooks/
   pre-commit` script catches them at the git layer. Both are
   belt-and-suspenders, not replacements for the discipline.
2. **Enable the pre-commit hook on first clone:**
   `git config core.hooksPath .githooks`. (See
   [Quickstart](README.md#quickstart).)
3. **If you see `chat-arch-data/manifest.json` in `git status`
   output as modified, that is local data**. Leave it unstaged.
   Confirm before staging only if the *baseline shape* itself
   changed (e.g., a `schemaVersion` bump that adds a new
   top-level empty field).

Same rule applies to anything else under
`apps/standalone/public/chat-arch-data/` (`corrections.json`,
`applied-improvements.json`, `correction-candidates.json` etc.) —
those are also locally-generated and may carry PII.

## Build / test / lint commands

Run from the repo root:

- `pnpm install --frozen-lockfile` — setup (mirrors CI)
- `pnpm lint` — monorepo-wide
- `pnpm test` — monorepo-wide (vitest)
- `pnpm build` — monorepo-wide (all workspaces build their dist/)

Per-package alternatives:

- `pnpm --filter @chat-arch/viewer <script>` for viewer-only runs
- `pnpm --filter @chat-arch/standalone dev` to boot the dev server
  on port 4324 (via `pnpm dev` at root)

## Shape of the workspace

```
apps/standalone/     Astro shell + /api/rescan + /api/clear endpoints
                     + /api/mine-corrections + /api/clear-corrections
packages/schema/     UnifiedSessionEntry + manifest + correction types
packages/exporter/   CLI + parsers + analysis writers + sub-CLIs
                     (embed-cli, ingest-configs-cli,
                      cluster-corrections-cli)
packages/analysis/   Shared cloud-mapping + clustering +
                     correction-recall kernels
packages/viewer/     React viewer (mount target)
scripts/             One-off audits (audit-correction-recall.mjs)
.claude/skills/
  mine-corrections/  Skill driving the corrections LLM stages
```

Viewer imports from `@chat-arch/analysis`, not `@chat-arch/exporter`
subpaths — the exporter's `exports` field only declares the root.

## Versioning

User-facing version lives in `packages/exporter/src/analysis/index.ts`
as `EXPORTER_VERSION` and is written into `analysis/meta.json` after
every rescan. Bump it (and add a `CHANGELOG.md` entry) when the on-
disk file shape changes or a user-visible feature ships. Workspace
packages stay at `0.0.0` — they're private and not published.

A second version — `HEURISTIC_RECALL_VERSION` in
`packages/analysis/src/detectCorrectionCandidates.ts` — gates the
incremental-rescan cache for the corrections heuristic. Bump it
whenever you change a regex family in that file; the cache will then
self-invalidate on next rescan. Update the history block in the same
file when you bump.

## Data on disk (for reference when touching wipe/clear logic)

Three IndexedDB databases live on the client:

- `chat-arch` (uploaded ZIP bytes)
- `chat-arch-semantic-labels` (per-session topic assignments)
- `chat-arch-bench-results` (dev-only benchmark metrics)

A "delete cloud data" action must wipe all three — they're all
cloud-corpus-derived. See `NuclearReset.tsx` for the canonical
sequence (Promise.allSettled of the three `clearX()` helpers).

The corrections pipeline writes three files under
`apps/standalone/public/chat-arch-data/analysis/` (all gitignored):

- `correction-candidates.json` — exporter output (heuristic recall +
  scan stats). Regenerated by `pnpm exporter run start` or
  `/api/rescan`.
- `corrections.json` — skill output (LLM-classified corrections +
  clustered patterns + proposed upgrades). Wiped by
  `/api/clear-corrections`; produced by `/api/mine-corrections`.
- `correction-status-${requestId}.json` — per-run progress files the
  skill writes during a mining pass. The viewer polls them while a
  run is in flight; the clear endpoint sweeps them up.
