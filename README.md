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
the first run auto-seeds a **synthetic demo corpus** so nothing ever renders
empty. A `DEMO DATA` chip marks it as fictional. The demo is only useful for
getting a feel for the interface; jump to **[Getting your own data](#getting-your-own-data)**
below to wire up a real corpus.

> **No Claude Code or Anthropic account required to _run_ chat-arch.** The
> tool is a plain Node app — it just reads Claude transcripts that already
> exist on your disk or in a Privacy-Export ZIP you download from claude.ai.
> No API calls, no login, no telemetry. If you've never used any Claude
> product, chat-arch has nothing to show you beyond the demo; see
> [Not a Claude user (yet)](#not-a-claude-user-yet) at the bottom.

### Requirements

| Tool | Version          |
| ---- | ---------------- |
| Node | ≥ 22             |
| pnpm | 10.32.1 (pinned) |

The repo uses pnpm workspaces with `strict-peer-dependencies=true`. If
`pnpm install` complains about peer-dep mismatches, that's a real issue
worth understanding rather than overriding.

## Getting your own data

chat-arch reads four kinds of Claude transcript, each written to disk by a
different product. Which path applies depends on how you use Claude.

### Claude Code (CLI) — on disk, one click

If you've run `claude` in a terminal at any point, your transcripts are
already in `~/.claude/projects/<project>/<session>.jsonl`.

1. In the top bar of the viewer, click **SCAN LOCAL**.
2. Wait a few seconds (a thousand sessions takes ~5s on a modern SSD).
3. The demo banner and demo data vanish. You're looking at your own corpus.

Same for **Claude Desktop** and **Claude Cowork** — they write to
`%APPDATA%\Claude\local-agent-mode-sessions\` on Windows (and equivalent
paths on macOS / Linux). **SCAN LOCAL** walks all of them in one pass.

### claude.ai (web) — Privacy-Export ZIP

The web app doesn't sync anything to your local disk, so you have to ask
Anthropic to dump your data. It's a one-click operation that returns an
email with a download link, usually within a few minutes.

1. Go to https://claude.ai and sign in.
2. Click your avatar (bottom-left) → **Settings**.
3. Open the **Privacy** tab → click **Export data**.
4. Wait for the confirmation email. The ZIP is typically under 50 MB even
   for heavy users.
5. Back in chat-arch, click **UPLOAD CLOUD** in the top bar and pick the
   ZIP you just downloaded.

The same ZIP can be re-uploaded any time — chat-arch deduplicates by
conversation id, so re-exporting monthly to pull in new conversations is
the expected workflow.

### What it ingests (reference)

| Source            | Where it lives on disk                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| Claude Code (CLI) | `~/.claude/projects/<project>/<session>.jsonl`                         |
| Claude Cowork     | `%APPDATA%\Claude\local-agent-mode-sessions\…\*.jsonl`                 |
| Claude Desktop    | `%APPDATA%\Claude\local-agent-mode-sessions\…\*.jsonl`                 |
| Privacy Export    | The ZIP from **claude.ai → avatar → Settings → Privacy → Export data** |

Local paths are scanned by `packages/exporter` (CLI; also exposed via the
in-app **SCAN LOCAL** button). The Privacy-Export ZIP is parsed entirely
in the browser by the viewer.

### Not a Claude user (yet)?

chat-arch is Claude-specific by design — it knows the exact JSONL and JSON
shapes that Anthropic's products write, and converts them to one unified
schema.

If you primarily use another assistant, the comparison table below lists
adjacent tooling; `1ch1n/mychatarchive` is the closest multi-provider
analogue. If you want to try Claude:

- **Claude Code (CLI)** — https://www.anthropic.com/claude-code
- **claude.ai (web)** — https://claude.ai

Once you've used either, come back and follow
[Getting your own data](#getting-your-own-data) above.

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
