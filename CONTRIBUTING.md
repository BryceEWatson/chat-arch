# Contributing to chat-arch

Thanks for your interest. `chat-arch` is a small personal-productivity tool;
contributions are welcome and the bar is "don't make it worse."

## Setup

```sh
pnpm install
pnpm dev          # runs the standalone Astro app on http://localhost:4321
pnpm test         # runs the full vitest suite
pnpm lint         # eslint, must exit 0
pnpm format:check # prettier, must exit 0
```

Node ≥ 22 and pnpm 10.32.1 (pinned in `package.json`'s `packageManager` field).

## Where to put things

```
apps/
  standalone/        Astro shell + dev-only /api/rescan route
packages/
  schema/            UnifiedSessionEntry + manifest types
  exporter/          parsers + analysis writers (also exports the CLI)
  viewer/            React viewer
```

Tests live next to source as `*.test.ts` / `*.test.tsx`. Vitest is configured
at the workspace root.

## Pull-request checklist

Before opening a PR:

- [ ] `pnpm test` green (no skipped tests added without a comment explaining why)
- [ ] `pnpm lint` exits 0
- [ ] `pnpm format:check` exits 0
- [ ] No literal personal data (real emails, real project names, real chat
      content) in any file. The fixtures under `packages/viewer/test/fixtures/`
      and `packages/exporter/test/fixtures/` are the canonical place for sample
      data and they are explicitly synthetic.
- [ ] No new dependencies on copyleft (GPL / AGPL) packages. MIT / Apache /
      BSD / ISC are fine.
- [ ] If you touched the rescan endpoint, the CSRF gate
      (Origin allow-list + `X-Requested-With` token) still rejects cross-origin
      POSTs.
- [ ] If you touched `ContentBlock.tsx`, the XSS regression tests
      (`ContentBlock.test.tsx`) still pin the escape-first / markdown-second
      order.

## Commit style

Conventional-commits-ish prefixes match the existing log:
`feat()`, `fix()`, `chore()`, `docs()`, `refactor()`, `polish()`.

The body should explain _why_, not _what_ — the diff already shows what
changed.

## Filing issues

For bugs, the issue template asks for:

- what you ran (`pnpm dev` / `pnpm --filter @chat-arch/exporter start …`)
- what you expected
- what you got, including any console / terminal output
- which OS + node + pnpm version

For feature requests, please describe the underlying problem first —
"I want to find sessions where I asked the same question twice" is more
useful than "add a duplicates view," even though the latter might be the
right answer.

## Security

For security-sensitive issues, please **do not** open a public issue. See
[`SECURITY.md`](SECURITY.md) for the disclosure path.

## Code of conduct

Be kind. Disagreement is fine; condescension is not. Harassment, personal
attacks, or bad-faith argument get you removed from the issue tracker; repeat
offenses get you blocked from the repo.
