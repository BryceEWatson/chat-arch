# chat-arch

> Find the rules Claude keeps breaking. Patch your CLAUDE.md. Prove the loop closed.

A local-first workshop for turning your Claude conversation history into
reusable improvements. Mines your transcripts for correction patterns —
places where you pushed back on Claude — clusters them into recurring
rules, and helps you encode fixes into your CLAUDE.md, skills, and agent
configs. Then watches whether those fixes hold on the next pass through
your data.

Underneath the workshop is a fast viewer + indexer for the corpus
itself: search, project rollups, and a unified timeline across Claude
Code CLI, Desktop, Cowork, and claude.ai cloud-export ZIPs. Reads the
JSONL files Claude Code writes to disk plus the ZIP you get from
**Settings → Privacy → Export data**.

**Local-first by construction.** Your transcripts never leave your machine.
The hosted viewer at **[chat-arch.dev](https://chat-arch.dev)** is a static
Cloudflare Pages build with no backend — it's a demo of what chat-arch
can do. The full workshop loop (SCAN LOCAL, mine corrections, apply
fixes) runs on a local `pnpm dev` checkout that exposes a same-origin
`/api/rescan` endpoint so **SCAN LOCAL** can walk `~/.claude/projects/`
and `%APPDATA%\Claude` (`localhost` only; nothing egresses). The only
cross-origin fetch on either path is the optional Hugging Face
model-weight download on first **Analyze Topics** run — see
[Model-weight trust boundary](#model-weight-trust-boundary) below. No
telemetry, no analytics beacons, no transcript upload.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Live demo: chat-arch.dev](https://img.shields.io/badge/demo-chat--arch.dev-5b7cff)](https://chat-arch.dev)

---

## Try it without installing

The fastest path to kick the tires:

1. Open **[chat-arch.dev](https://chat-arch.dev)**.
2. Click **LOAD DEMO DATA** to populate the viewer with a synthetic
   fixture corpus (clearly marked `DEMO DATA`), or drop a claude.ai
   **Privacy-Export ZIP** on **UPLOAD CLOUD** to view your own archive.
3. Everything renders client-side — the page ships as static files with
   no server routes, so nothing you upload is transmitted anywhere.

The hosted viewer can't read files from disk (it has no filesystem
access). To index your local `~/.claude/projects/` or `%APPDATA%\Claude`
transcripts from Claude Code CLI / Desktop / Cowork, run chat-arch
locally via the [Quickstart](#quickstart) below and use **SCAN LOCAL**.

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
git config core.hooksPath .githooks   # enable PII-leak guard
pnpm dev
```

The `core.hooksPath` line activates `.githooks/pre-commit`, which
rejects any commit that stages a populated
`apps/standalone/public/chat-arch-data/manifest.json`. That file is
tracked in its empty baseline form, but it gets *populated on disk*
by SCAN LOCAL — populated content (session titles, previews, costs)
is PII and must never be committed. One-time setup per clone.

Open http://localhost:4321. The viewer lands on a **NO DATA YET** screen
with three ways in:

- **SCAN LOCAL** — index your on-disk transcripts (Claude Code CLI,
  Desktop, Cowork). Dev-server-only, since it hits a local `/api/rescan`
  route that isn't part of the static deploy.
- **UPLOAD CLOUD** — drop a claude.ai Privacy-Export ZIP. Pure browser,
  works in dev and on [chat-arch.dev](https://chat-arch.dev).
- **LOAD DEMO DATA** — populate with a synthetic fixture corpus so you
  can explore the UI without exposing real conversations. A `DEMO DATA`
  chip marks it as fictional.

See [Getting your own data](#getting-your-own-data) below for the full
walkthrough of each ingestion path.

> **No Claude Code or Anthropic account required to _run_ chat-arch.** The
> viewer reads Claude transcripts that already exist on your disk or in
> a Privacy-Export ZIP you downloaded from claude.ai — no Claude-API
> calls, no login, no telemetry. Never used Claude? Click **LOAD DEMO
> DATA** to explore the full viewer (filters, sparkline, duplicate
> detection, topic clustering) against ~120 hand-written synthetic
> sessions; see [Not a Claude user (yet)](#not-a-claude-user-yet) at the
> bottom for multi-provider alternatives if Claude isn't your primary
> assistant.

### What ships beyond the workshop loop

The local-tier viewer now also surfaces an **outcome-substrate** layer
(EXPORTER_VERSION 1.2.0) that ranks sessions by a composite outcome
score and slices the corpus six ways:

| Mode | What it shows |
| ---- | ------------- |
| **Results** (`/results`) | Cross-corpus claim-pass rate by claim type / project / session + loop-closure rollup (shipped 1.1.0) |
| **Playbook** (`/playbook`) | Recurring user-turn phrasings ranked by occurrence × downstream pass-rate; COPY AS MARKDOWN handoff (shipped 1.1.0) |
| **Effectiveness** | Per-session composite score (test/build/PR/affirmation signals) + time-series |
| **Insights** | Interrupted-time-series contrasts of composite score around `.claude/` config changes |
| **Decisions** | Extracted decisions joined to downstream composite outcome |
| **Trust** | Pairwise `(source, archetype)` comparison via Holm-Bonferroni |
| **Trends** | Per-project trajectory (Theil-Sen + block-bootstrap CI) + skill-curve trends |
| **Export** | Obsidian-targeted markdown export (post-mortems + knowledge-debt) |

Eleven gitignored analysis sidecars under
`apps/standalone/public/chat-arch-data/analysis/` back these modes:
`composite-outcomes.json`, `pr-land-cache.json`, `config-history.json`,
`its-analysis.json`, `knowledge-debt.json`, `reflexive.json`,
`decisions.json`, `archetypes.json`, `project-trajectories.json`,
`surface-comparison.json`, `skill-curves.json`. Every mode ships a
`MethodologyDisclosure` panel + cell-level `SourceAttribution` labels
so derivations are auditable.

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
5. Open chat-arch — either [chat-arch.dev](https://chat-arch.dev) or a
   local `pnpm dev` checkout — click **UPLOAD CLOUD** in the top bar, and
   pick the ZIP you just downloaded. Parsing happens entirely in the
   browser; nothing is transmitted.

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

| Tool                                                                                  | Stars | What it does                                                     |
| ------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------- |
| [`daaain/claude-code-log`](https://github.com/daaain/claude-code-log)                 | 943★  | Python CLI, JSONL → HTML. Live data only.                        |
| [`simonw/claude-code-transcripts`](https://github.com/simonw/claude-code-transcripts) | 1.4k★ | Single-file static viewer.                                       |
| [`osteele/claude-chat-viewer`](https://github.com/osteele/claude-chat-viewer)         | 55★   | Privacy-Export ZIPs only.                                        |
| [`1ch1n/mychatarchive`](https://github.com/1ch1n/mychatarchive)                       | 27★   | Multi-provider (Claude/ChatGPT/Grok/Cursor), no GUI.             |
| [`ryoppippi/ccusage`](https://github.com/ryoppippi/ccusage)                           | 13k★  | Cost-tracking CLI. Adjacent space.                               |
| **chat-arch**                                                                         | —     | All four Claude surfaces unified, core + extended analysis, GUI. |

The differentiator is **unified ingestion across all four Claude data
surfaces** plus deterministic core-tier analysis (exact-duplicate prompt
detection, heuristic zombie-project classification, cost-by-model rollup,
sparkline timeline) computed on the user's own machine — everything needed
to navigate the corpus is live the moment the viewer loads, no pre-compute
step required.

## Design system

The viewer's retro-computing look — chunky supergraphic panels, dual-track
typography, a stepped butterscotch/salmon/peach palette — is extracted into
a standalone, replicable design system called **Supergraphic Panel**:

- [**Walkthrough**](https://chat-arch.dev/design-system/) — human-facing
  tour with live specimens, swatches, and port recipes.
- [**Prose spec**](https://chat-arch.dev/design-system/spec.md) — the
  canonical specification, written to be consumable by an LLM agent
  applying the system to another project.
- [**Design tokens**](https://chat-arch.dev/design-system/tokens.json) —
  [DTCG 2025.10](https://www.designtokens.org/schemas/2025.10/format.json)
  format. Source palette and font families are extracted from the viewer
  stylesheet; scale tokens are prescriptive.

The prose spec and token source live under
[`design-system/`](design-system/) at the repo root and are mirrored to
the hosted deploy by the standalone build. The walkthrough page source
is an Astro page at
[`apps/standalone/src/pages/design-system/index.astro`](apps/standalone/src/pages/design-system/index.astro).

## Repo layout

```
apps/
  standalone/        Astro shell. Hosts the viewer and, in dev, the
                     /api/rescan + /api/clear + /api/mine-corrections +
                     /api/clear-corrections endpoints. The `pnpm build`
                     output (static client bundle) is what ships to
                     chat-arch.dev via Cloudflare Pages.
packages/
  schema/            UnifiedSessionEntry + manifest + correction types.
                     Pure TypeScript.
  exporter/          CLI + parsers for the four input sources, plus the
                     core-tier analysis writers (duplicates.exact,
                     zombies.heuristic, projects, topics, narratives,
                     correction-candidates, meta) and a set of CLIs
                     used by the /mine-corrections skill (embed-cli,
                     ingest-configs-cli, cluster-corrections-cli).
  analysis/          Shared cloud-mapping + clustering + correction-
                     recall kernels used by both the exporter (at
                     build time) and the viewer (at runtime).
  viewer/            React viewer. Mounts against
                     /chat-arch-data/manifest.json.
design-system/       Supergraphic Panel source — prose spec + token
                     generator. Mirrored to chat-arch.dev/design-system/
                     at build time.
scripts/             One-off audit + diagnostic scripts (e.g.
                     audit-correction-recall.mjs).
.claude/skills/
  mine-corrections/  Claude Code skill that drives the LLM stages of
                     the corrections pipeline. Invoked locally via
                     /api/mine-corrections.
```

### Corrections (dev-only mining)

The exporter writes `analysis/correction-candidates.json` — a heuristic
recall pass over every user turn that finds likely
corrections-to-the-AI (negation, "instead of", caps frustration, repeat
instructions, soft redirects, preference statements, …). The viewer's
**CORRECTIONS** panel reads this plus an LLM-classified
`analysis/corrections.json` and surfaces clustered patterns in three
buckets:

- `RECURRING AFTER APPLIED` — you wrote a rule, the model still gets
  it wrong.
- `ALREADY ENCODED BUT FAILING` — the rule already lives in your
  CLAUDE.md but is being violated.
- `NEW PATTERNS TO ENCODE` — recurring corrections with no matching
  config, paired with proposed CLAUDE.md / settings-hook / skill /
  agent / command upgrades.

Each pattern card shows confidence, distinct-session count, instance
excerpts, and concrete patch text — `COPY PATCH` for manual review,
`APPLY` to write to disk after explicit per-proposal approval.

The LLM stages run **locally** via the `/mine-corrections` Claude Code
skill, which the panel invokes through the dev-only
`/api/mine-corrections` endpoint. The endpoint spawns the `claude` CLI
in your shell against the project's `.claude/skills/mine-corrections/`
directory; nothing is uploaded anywhere — your transcripts and your
classifications stay on your machine. Counts against your Claude Code
plan usage; no separate billing.

## Privacy

`chat-arch` is local-first by construction — no telemetry, no analytics
beacons, no transcript upload. Transcripts stay in the environment you
loaded them from: on disk if you ran `pnpm dev` and clicked **SCAN LOCAL**
(parsed by the Astro dev server on `localhost`), or in the browser tab's
memory / IndexedDB if you uploaded a Privacy-Export ZIP to chat-arch.dev.
The one cross-origin fetch on either path is the optional Hugging Face
model-weight download on first **Analyze Topics** run — see
[Model-weight trust boundary](#model-weight-trust-boundary) below for the
full disclosure.

The corrections-mining pipeline (the **MINE CORRECTIONS** button in a
local `pnpm dev` checkout) is no exception: the LLM classification +
clustering stages run against the project's local
`.claude/skills/mine-corrections/` skill via the user's own `claude`
CLI binary. Sub-agent calls dispatched by the skill consume the user's
Claude Code plan usage but no chat-arch process or page sends transcripts
anywhere — the only network I/O is whatever the user's `claude` install
already does on their behalf. The hosted `chat-arch.dev` deploy has no
mining endpoint at all.

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

Headline points:

- **The hosted deploy has no server-side endpoints.** `chat-arch.dev`
  serves only static HTML/JS/CSS from Cloudflare Pages — there is no
  `/api/rescan`, `/api/clear`, `/api/mine-corrections`, or
  `/api/clear-corrections`, and no backend that can read the filesystem
  or mutate server-side state.
- In a local `pnpm dev` checkout, every `/api/*` endpoint requires
  same-origin Origin AND a custom `X-Requested-With` header — a hostile
  cross-origin page in your browser cannot trigger a rescan, a clear,
  or a corrections-mining run via a simple form submit.
- `/api/mine-corrections` spawns the `claude` CLI with a fixed
  `--allowedTools` whitelist (Read / Write / Edit / Bash / Task / Glob /
  Grep). The `-p` prompt is constructed from a fixed slash-command
  template plus a server-generated request UUID — there is no path for
  raw user input to reach the shell.
- `/api/clear-corrections` only deletes files in
  `analysis/` whose names match a static allow-list (`corrections.json`,
  `correction-status-*.json`, `_correction-target-ids-*.json`). It
  cannot remove anything outside that pattern, including
  `correction-candidates.json` (the upstream input).
- The viewer escapes user content before passing it to React's
  `dangerouslySetInnerHTML`, with regression tests pinning the escape order.
- The production build emits a strict Content-Security-Policy
  (`script-src 'self'` plus hash-allowlisted inline scripts for Astro's
  island loader; no eval; no remote script origins) as defense-in-depth.
- **Session IDs appear in the URL hash** (`#session/<uuid>`) so a specific
  conversation can be deep-linked. The hash lands in browser history and
  in any outbound `Referer` header to a clicked external link. The IDs
  themselves don't carry content — they're opaque v4 UUIDs generated
  locally — but if you share your browser history or screen with someone,
  the URL bar can reveal which conversations you've been looking at.
  Clear history to reset.

### Model-weight trust boundary

The semantic-labels panel runs `Xenova/bge-small-en-v1.5` (a ~36 MB ONNX
embedder) entirely in the browser via
[`@huggingface/transformers`](https://huggingface.co/docs/transformers.js).
The model weights are fetched from the Hugging Face CDN on first run and
cached locally by the browser's HTTP cache and transformers.js's own
IndexedDB layer.

**There is no Subresource Integrity / SHA-256 pin on the weights.** This
is the same posture as every other in-browser ML tool that ships via
transformers.js today — SRI on arbitrary-origin fetches from
`huggingface.co` isn't wired through the library, and hand-maintaining a
per-revision SHA-256 allowlist would drift out of date on the first
upstream patch. The practical trust boundary is:

- You trust Hugging Face as the weight distributor (same as you trust
  npm for JS packages or Docker Hub for images).
- You trust TLS + HTTP cache for in-transit integrity.
- You accept that a compromised HF CDN could ship modified weights
  that degrade the viewer's clustering quality (but cannot exfiltrate
  data — the worker has no network permission beyond its own asset
  fetches, and no conversation content is ever sent back).

The ORT-WASM runtime itself (the JS glue + WASM binary that executes
the weights) is self-hosted under `apps/standalone/public/ort-wasm/`
and loaded same-origin — not from a third-party CDN. See
`packages/viewer/src/data/ortWasmPaths.ts` for the fail-closed resolver
that refuses to fall back to `cdn.jsdelivr.net`.

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
