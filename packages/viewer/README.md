# @chat-arch/viewer

React viewer for chat-arch session manifests. Internal workspace package
(not currently published to npm).

## Consumer integration

```tsx
import { ChatArchViewer } from '@chat-arch/viewer';
import '@chat-arch/viewer/style.css';

export default function App() {
  return <ChatArchViewer />;
}
```

The viewer fetches `/chat-arch-data/manifest.json` by default. Override via
props:

```tsx
<ChatArchViewer manifestUrl="/my-path/manifest.json" dataRoot="/my-path" />
```

Pre-load the manifest to skip the fetch (SSG path):

```tsx
<ChatArchViewer manifest={manifest} />
```

### Props

| Prop          | Default                         | Purpose                                                    |
| ------------- | ------------------------------- | ---------------------------------------------------------- |
| `manifest`    | —                               | Pre-loaded `SessionManifest`. Skips the initial fetch.     |
| `manifestUrl` | `/chat-arch-data/manifest.json` | URL the viewer fetches on mount.                           |
| `dataRoot`    | `/chat-arch-data`               | Base URL drill-in `transcriptPath` values resolve against. |

### Font

The retro-terminal theme uses the `Antonio` font with a fallback chain of
`Oswald, Impact, sans-serif`. Consumers load the font (`apps/standalone`
pulls it in via `BaseLayout.astro`). The viewer does not bundle web-fonts.

### Minimum viewport

The viewer is laid out for desktop (900px+) but degrades through tablet,
mobile, and a final 320px-fallback banner.

## Two-tier analysis architecture

`chat-arch` separates deterministic pure-function analysis from LLM-powered
analysis:

- **Browser tier (default).** The exporter computes everything that can be
  derived with deterministic code — cost estimates, exact-match duplicate
  prompts, heuristic zombie-project classification — and writes them to
  `public/chat-arch-data/analysis/{duplicates.exact,zombies.heuristic,meta}.json`.
  The viewer fetches these on mount and renders them directly.
- **Local tier (planned).** A Claude-Code skill (`chat-arch-analyzer`, not
  yet shipped) will read the manifest and write `{duplicates.semantic,
zombies.diagnosed, reloops, handoffs, cost-diagnoses, skill-seeds}.json`
  into the same directory. The viewer auto-detects these and surfaces them
  in the same UI surfaces as the browser-tier outputs.

**Never the same filename across tiers.** Re-running the exporter never
overwrites a local-tier artifact, and vice versa. The `BROWSER ANALYSIS` /
`BROWSER + LOCAL ANALYSIS (N/6)` pill in the TopBar reflects which tier files
are currently present; source-attribution micro-labels (`· exact`,
`· heuristic`, `· estimate`, `· semantic`, `· diagnosed`) tell the user on
every chip and KPI whether a given insight came from regex or judgment.

## Dev harness

Run the viewer against the hand-authored 100-entry fixture:

```sh
pnpm --filter @chat-arch/viewer dev
```

This syncs `test/fixtures/` into `demo/public/chat-arch-data/` and starts
Vite on `http://localhost:5178/`. Reviewers can point Playwright at that URL.

### Fixture regeneration

```sh
cd packages/viewer
node test/fixtures/generate-manifest.mjs
pnpm sync-demo-fixture
```

The generator is deterministic (seeded RNG). Drill-in files in
`test/fixtures/conversations/` and `test/fixtures/local-transcripts/` are
hand-authored and committed.

## Alternative harness (no Vite)

Point the existing Astro shell at the fixture by copying:

```sh
cp packages/viewer/test/fixtures/realistic-manifest.json \
   apps/standalone/public/chat-arch-data/manifest.json
cp -r packages/viewer/test/fixtures/conversations \
      apps/standalone/public/chat-arch-data/cloud-conversations
cp -r packages/viewer/test/fixtures/local-transcripts \
      apps/standalone/public/chat-arch-data/local-transcripts
pnpm --filter @chat-arch/standalone dev
```

Restore real data by re-running the exporter.
