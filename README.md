# chat-arch

> The personal archive for your Claude conversation history.

A local-first viewer + indexer for your own Claude Code transcripts. Reads the
JSONL files Claude Code writes to disk plus the ZIP you get from
**Settings → Privacy → Export data**, unifies them into a single timeline, and
gives you search, filters, cost analytics, and a duplicate / zombie-project
view for the corpus you've already built.

**Local-first.** Runs entirely in a browser tab against a local web server.
No API calls, no cloud sync, no analytics beacons. Your transcripts never
leave your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Why

Claude Code transcripts pile up fast. After a year of heavy use you have
thousands of JSONL files split across `~/.claude/projects/`, `%APPDATA%\Claude`,
the Claude Cowork sync directory, and whatever Privacy-Export ZIPs you've
downloaded. There is no built-in way to search them, no built-in way to ask
"what did that 9pm session three months ago actually cost," and no built-in
way to find the conversations you keep restarting because the previous one
got too long.

`chat-arch` reads all of that, normalizes it into one schema, and gives you
a viewer that treats your conversation history as the corpus it actually is.

## Quickstart

```sh
pnpm install
pnpm dev
```

Open http://localhost:4321. You'll see a populated viewer immediately —
the first run auto-seeds a synthetic demo corpus so you can poke around.
A `DEMO DATA` banner at the top reminds you it's fictional. Click the
RESCAN button (top bar, left) to walk your real Claude data directories
and replace the demo with your own transcripts.

For cloud (claude.ai web) data, click the **Upload Cloud** button and
pick a Privacy-Export ZIP. Uploading the same ZIP twice is harmless —
duplicates merge by conversation id.

### Requirements

| Tool | Version          |
| ---- | ---------------- |
| Node | ≥ 22             |
| pnpm | 10.32.1 (pinned) |

The repo uses pnpm workspaces with `strict-peer-dependencies=true`. If
`pnpm install` complains about peer-dep mismatches, that's a real issue
worth understanding rather than overriding.

## What it ingests

| Source            | Where it lives on disk                                   |
| ----------------- | -------------------------------------------------------- |
| Claude Code (CLI) | `~/.claude/projects/<project>/<session>.jsonl`           |
| Claude Cowork     | `%APPDATA%\Claude\local-agent-mode-sessions\…\*.jsonl`   |
| Claude Desktop    | `%APPDATA%\Claude\local-agent-mode-sessions\…\*.jsonl`   |
| Privacy Export    | The ZIP from **Settings → Privacy → Export data** on web |

Real local-data paths are scanned by `packages/exporter` (CLI; also exposed
via the in-app **RESCAN** button). The Privacy-Export ZIP is parsed entirely
in the browser by the viewer.

## How chat-arch compares

| Tool                                                                                  | Stars | What it does                                              |
| ------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------- |
| [`daaain/claude-code-log`](https://github.com/daaain/claude-code-log)                 | 943★  | Python CLI, JSONL → HTML. Live data only.                 |
| [`simonw/claude-code-transcripts`](https://github.com/simonw/claude-code-transcripts) | 1.4k★ | Single-file static viewer.                                |
| [`osteele/claude-chat-viewer`](https://github.com/osteele/claude-chat-viewer)         | 55★   | Privacy-Export ZIPs only.                                 |
| [`1ch1n/mychatarchive`](https://github.com/1ch1n/mychatarchive)                       | 27★   | Multi-provider (Claude/ChatGPT/Grok/Cursor), no GUI.      |
| [`ryoppippi/ccusage`](https://github.com/ryoppippi/ccusage)                           | 13k★  | Cost-tracking CLI. Adjacent space.                        |
| **chat-arch**                                                                         | —     | All four Claude surfaces unified, browser analytics, GUI. |

The differentiator is **unified ingestion across all four Claude data
surfaces** plus deterministic browser-tier analytics (exact-duplicate prompt
detection, heuristic zombie-project classification, cost-by-model rollup,
sparkline timeline) computed on the user's own machine.

## Repo layout

```
apps/
  standalone/        Astro shell that serves the viewer + the dev-only
                     /api/rescan endpoint. The dev server seeds a demo
                     corpus on first run if no real data is present.
packages/
  schema/            UnifiedSessionEntry + manifest types. Pure TypeScript.
  exporter/          CLI + parsers for the four input sources, plus the
                     browser-tier analysis writers (duplicates.exact,
                     zombies.heuristic, meta).
  viewer/            React viewer. Mounts against
                     /chat-arch-data/manifest.json.
```

## Privacy

`chat-arch` is local-first by construction — no telemetry, no API calls, no
cloud sync. Your transcripts stay on your disk.

**Note for users**: your own transcripts may contain other people's content
(prompts about colleagues, pasted client work, customer data). If you publish
screenshots from a populated viewer, treat them the same way you'd treat
publishing the underlying transcripts. The included demo corpus is fictional
for exactly this reason — please use it (not your real data) for any public
demos.

## Security

For security-sensitive issues, please open a private security advisory on
GitHub rather than a public issue. See [`SECURITY.md`](SECURITY.md) for
the full disclosure policy and the list of known limitations.

The most relevant points for the typical local-dev use case:

- The `/api/rescan` dev-server endpoint requires same-origin Origin and a
  custom `X-Requested-With` header — a hostile cross-origin page in your
  browser cannot trigger a rescan.
- The viewer escapes user content before passing it to React's
  `dangerouslySetInnerHTML`, with regression tests pinning the escape order.
- The production build emits a strict Content-Security-Policy header
  (`script-src 'self'`, no inline, no eval) as defense-in-depth.

## Disclaimers

**Not affiliated with Anthropic.** "Claude" and "Claude Code" are trademarks
of Anthropic PBC, used here descriptively to identify the file format and
source of the data this tool reads. `chat-arch` makes no API calls to
Anthropic services and parses only files the user's own account has already
written to local disk. See Anthropic's
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and
[Usage Policy](https://www.anthropic.com/legal/aup) for the underlying
agreements.

**Not affiliated with CBS Studios / Paramount.** The viewer's UI is inspired
by retro-futurist console aesthetics including the LCARS school of 1980s
television design. All trademarks are the property of their respective
owners.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Tests live next to source
(`*.test.ts(x)`); `pnpm test` runs them all.

## License

[MIT](LICENSE) © `chat-arch` contributors.
