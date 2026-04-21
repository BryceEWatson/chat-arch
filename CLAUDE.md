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
packages/schema/     UnifiedSessionEntry + manifest types
packages/exporter/   CLI + parsers + core-tier analysis writers
packages/analysis/   Shared cloud-mapping + clustering utilities
packages/viewer/     React viewer (mount target)
```

Viewer imports from `@chat-arch/analysis`, not `@chat-arch/exporter`
subpaths — the exporter's `exports` field only declares the root.

## Data on disk (for reference when touching wipe/clear logic)

Three IndexedDB databases live on the client:

- `chat-arch` (uploaded ZIP bytes)
- `chat-arch-semantic-labels` (per-session topic assignments)
- `chat-arch-bench-results` (dev-only benchmark metrics)

A "delete cloud data" action must wipe all three — they're all
cloud-corpus-derived. See `NuclearReset.tsx` for the canonical
sequence (Promise.allSettled of the three `clearX()` helpers).
