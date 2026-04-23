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

`chat-arch` ships in two postures, both with a deliberately narrow
attack surface:

1. **Local dev checkout** (`pnpm dev` on `localhost:4321`) — has the
   `/api/rescan` + `/api/clear` endpoints, which walk the user's own
   filesystem. CSRF gates below apply here.
2. **Hosted static deploy** at [chat-arch.dev](https://chat-arch.dev)
   (Cloudflare Pages) — the `pnpm build` client bundle only. The server
   routes are not deployed, so there is no endpoint that reads the
   filesystem, no endpoint that mutates server-side state, and nothing
   for a cross-origin attacker to reach besides the static HTML/JS/CSS
   and the CF edge.

The realistic attackers and surfaces across both:

| Surface                       | Realistic attacker                                                        |
| ----------------------------- | ------------------------------------------------------------------------- |
| `/api/rescan` (dev-only)      | Hostile cross-origin page in the same browser; DNS-rebinding probes       |
| Privacy-Export ZIP upload     | A maliciously crafted ZIP given to a user                                 |
| Transcript content rendering  | A transcript containing attacker-supplied content (e.g. pasted from a PR) |
| `chat-arch-data/` re-share    | A user sharing or downloading someone else's `chat-arch-data/` bundle     |
| Hosted deploy (chat-arch.dev) | Supply-chain compromise of a build dependency; CF edge misconfiguration   |

Server-side threats against the hosted deploy are bounded by it being a
static build with no backend — there is no application logic running at
chat-arch.dev beyond CF's own edge.

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
- **`frame-ancestors` via meta-CSP is ignored by browsers**: the
  chat-arch.dev Cloudflare Pages deploy sets `X-Frame-Options: DENY` as
  an HTTP response header via `apps/standalone/public/_headers`, which
  is the widely-supported predecessor of `frame-ancestors` and prevents
  clickjacking on the hosted surface. Any other deployment host needs
  to set an equivalent header at its own edge — a meta-CSP won't cover
  this.

## Out of scope

- Security of the user's underlying filesystem and Claude account.
- Anthropic's own data handling.
- Browser extensions and other software running in the user's environment.
