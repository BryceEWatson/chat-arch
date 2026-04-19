# Security Policy

## Reporting a vulnerability

Please **do not** file a public GitHub issue for security-sensitive bugs.
Instead, open a [private security advisory](../../security/advisories/new)
on this repository. Include:

- a brief description of the issue
- the affected file paths and a reproduction (curl / minimal HTML page /
  small input file)
- whether you intend to publish a write-up, and on what timeline

We aim to acknowledge within a few days. Coordinated disclosure is
preferred for anything exploitable.

## Threat model

`chat-arch` is a local-first developer tool. The realistic attackers and
attack surfaces:

| Surface                        | Realistic attacker                                                        |
| ------------------------------ | ------------------------------------------------------------------------- |
| `/api/rescan` (Astro dev mode) | Hostile cross-origin page in the same browser; DNS-rebinding probes       |
| Privacy-Export ZIP upload      | A maliciously crafted ZIP given to a user                                 |
| Transcript content rendering   | A transcript containing attacker-supplied content (e.g. pasted from a PR) |
| `chat-arch-data/` re-share     | A user sharing or downloading someone else's `chat-arch-data/` bundle     |

Production and cloud-deployment threat models are out of scope — the tool
is designed for `localhost:4321` against the user's own filesystem.

## Current mitigations

- **CSRF on `/api/rescan`**: requires both a same-origin `Origin` header and
  a custom `X-Requested-With: chat-arch-rescan` header. Anything else returns 403. Implementation in
  `apps/standalone/src/pages/api/rescan.ts`.
- **Path traversal containment**: `readFirstHumanText()` resolves
  `entry.transcriptPath` against `outDir` and rejects paths that escape the
  base directory. Implementation in `packages/exporter/src/analysis/index.ts`.
- **XSS regression tests**: `ContentBlock.tsx` escapes user content before
  passing it to `dangerouslySetInnerHTML`. The test file
  `packages/viewer/src/components/ContentBlock.test.tsx` pins the
  escape-first / markdown-second order so a future refactor cannot silently
  re-introduce script execution.
- **Production CSP**: the standalone build emits a strict
  Content-Security-Policy header
  (`default-src 'self'; script-src 'self'; ...`). Defense in depth: even a
  successful XSS via `dangerouslySetInnerHTML` cannot exfiltrate to a
  third-party origin or load remote scripts. The CSP is gated on
  `import.meta.env.PROD` because Vite/Astro dev mode requires inline scripts
  for HMR.

## Known limitations

- **`@astrojs/node` 9.5.5 (DoS)**: a known memory-exhaustion DoS exists in
  the v9 line of the Astro Node adapter
  (large-body POST against `/_server-islands/*` crashes the dev server).
  Upgrading requires Astro v6 (a major framework bump). Tracked as a
  follow-up. The DoS is a denial of service against a local dev server only —
  no RCE, no data leakage.
- **`yaml` transitive (dev-only)**: a transitive `yaml` < 2.8.3 stack-overflow
  advisory surfaces via `astro check`. Dev-tooling only; not on the
  production path.
- **GET `/api/rescan` is unauthenticated**: it returns only
  `{ok, available, busy}` with no side effects, so the unauthenticated probe
  is intentional.
- **`frame-ancestors` via meta-CSP is ignored by browsers**: a future
  production deployment behind a real reverse proxy should set
  `frame-ancestors 'none'` as an actual HTTP response header to fully
  prevent clickjacking.

## Out of scope

- Security of the user's underlying filesystem and Claude account.
- Anthropic's own data handling.
- Browser extensions and other software running in the user's environment.
