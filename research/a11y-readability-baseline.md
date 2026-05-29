# Accessibility + Readability Baseline

**Purpose:** Source material for the chat-arch UI a11y + readability review loop.
**Generated:** 2026-05-26 (research /loop, four parallel Explore subagents).
**Status:** Working document — read this before any review iteration.

---

## 1. UI surface inventory

### Astro pages — apps/standalone/src/pages/

| Surface | What it renders | Path |
|---|---|---|
| `index.astro` | TODAY feed: daily brief + surprises + curator + corrections + narratives | [index.astro](apps/standalone/src/pages/index.astro) |
| `sessions.astro` | Legacy session browser | [sessions.astro](apps/standalone/src/pages/sessions.astro) |
| `projects.astro` | Project index w/ drill-in | [projects.astro](apps/standalone/src/pages/projects.astro) |
| `projects/[id].astro` | Project detail + narrative-joined sessions | [projects/[id].astro](apps/standalone/src/pages/projects/[id].astro) |
| `topics.astro` | Topic index + side-panel | [topics.astro](apps/standalone/src/pages/topics.astro) |
| `topics/[id].astro` | Topic detail | [topics/[id].astro](apps/standalone/src/pages/topics/[id].astro) |
| `practice.astro` | Practice audit dashboard | [practice.astro](apps/standalone/src/pages/practice.astro) |
| `views.astro` | Flat catalogue of kernel surfaces | [views.astro](apps/standalone/src/pages/views.astro) |
| `audit.astro` | Claim-verifier results w/ filtering | [audit.astro](apps/standalone/src/pages/audit.astro) |
| `results.astro` | Cross-corpus outcomes table | [results.astro](apps/standalone/src/pages/results.astro) |
| `health.astro` | Continuum health dashboard | [health.astro](apps/standalone/src/pages/health.astro) |
| `playbook.astro` | Verified methods ranked | [playbook.astro](apps/standalone/src/pages/playbook.astro) |
| `blog-drafts/index.astro` | Blog draft index | [blog-drafts/index.astro](apps/standalone/src/pages/blog-drafts/index.astro) |
| `blog-drafts/[slug].astro` | Blog draft render + inline citations | [blog-drafts/[slug].astro](apps/standalone/src/pages/blog-drafts/[slug].astro) |
| `personas.astro` | Per-project personas (SCAN step 5) | [personas.astro](apps/standalone/src/pages/personas.astro) |
| `design-system/index.astro` | Token + palette reference | [design-system/index.astro](apps/standalone/src/pages/design-system/index.astro) |
| `calibrate.astro` | Threshold calibration harness | [calibrate.astro](apps/standalone/src/pages/calibrate.astro) |
| `bench.astro` | Dev-only benchmark runner | [bench.astro](apps/standalone/src/pages/bench.astro) |

API routes (~20 under `pages/api/*`) are non-UI; excluded from review scope.

### Viewer modes — packages/viewer/src/components/modes/

| Mode | Role | Path |
|---|---|---|
| `EffectivenessMode` | Weekly trajectory + EWMA + Wilson CI | [EffectivenessMode.tsx](packages/viewer/src/components/modes/EffectivenessMode.tsx) |
| `InsightsMode` | Insight rows + ack state | [InsightsMode.tsx](packages/viewer/src/components/modes/InsightsMode.tsx) |
| `DecisionsMode` | Decision table + composite chips | [DecisionsMode.tsx](packages/viewer/src/components/modes/DecisionsMode.tsx) |
| `TrustMode` | 2×2 grid w/ Wilson CIs | [TrustMode.tsx](packages/viewer/src/components/modes/TrustMode.tsx) |
| `TrendsMode` | Trajectories + archetypes + skill curves | [TrendsMode.tsx](packages/viewer/src/components/modes/TrendsMode.tsx) |
| `ExportMode` | Export-kind checklist w/ filters | [ExportMode.tsx](packages/viewer/src/components/modes/ExportMode.tsx) |
| `CommandMode` | Session grid + chips + sort/filter | [CommandMode.tsx](packages/viewer/src/components/modes/CommandMode.tsx) |
| `DetailMode` | Full session transcript renderer | [DetailMode.tsx](packages/viewer/src/components/modes/DetailMode.tsx) |
| `TimelineMode` | Chronological timeline lanes | [TimelineMode.tsx](packages/viewer/src/components/modes/TimelineMode.tsx) |
| `ProjectsMode` | Project list w/ narrative cards | [ProjectsMode.tsx](packages/viewer/src/components/modes/ProjectsMode.tsx) |
| `TopicsMode` | Topic index + side-panel | [TopicsMode.tsx](packages/viewer/src/components/modes/TopicsMode.tsx) |
| `PracticeMode` | Audit findings by lens + curator | [PracticeMode.tsx](packages/viewer/src/components/modes/PracticeMode.tsx) |
| `ChatMode` | Q&A streaming chat | [ChatMode.tsx](packages/viewer/src/components/modes/ChatMode.tsx) |
| chat subs | [ChatStreamedMessage](packages/viewer/src/components/modes/chat/ChatStreamedMessage.tsx) · [AgentTrace](packages/viewer/src/components/modes/chat/AgentTrace.tsx) · [CitationChip](packages/viewer/src/components/modes/chat/CitationChip.tsx) · [DisclosureModal](packages/viewer/src/components/modes/chat/DisclosureModal.tsx) | |

### Shared widgets (high-value, full list in inventory output)

Layout shell: [TopBar](packages/viewer/src/components/TopBar.tsx), [Sidebar](packages/viewer/src/components/Sidebar.tsx), [DataPanel](packages/viewer/src/components/DataPanel.tsx), [UpperPanel](packages/viewer/src/components/UpperPanel.tsx), [MidBar](packages/viewer/src/components/MidBar.tsx), [ChatArchViewer (entry)](packages/viewer/src/ChatArchViewer.tsx).

Content: [SessionCard](packages/viewer/src/components/SessionCard.tsx), [TranscriptList](packages/viewer/src/components/TranscriptList.tsx), [MessageList](packages/viewer/src/components/MessageList.tsx), [ContentBlock](packages/viewer/src/components/ContentBlock.tsx), [FilterBar](packages/viewer/src/components/FilterBar.tsx).

Cards/charts: [CorrectionPatternCard](packages/viewer/src/components/CorrectionPatternCard.tsx), [OutcomeSparkline](packages/viewer/src/components/OutcomeSparkline.tsx), [Sparkline](packages/viewer/src/components/Sparkline.tsx), [TierIndicator](packages/viewer/src/components/TierIndicator.tsx), [TrustStrip](packages/viewer/src/components/TrustStrip.tsx).

States: [EmptyState](packages/viewer/src/components/EmptyState.tsx), [SidecarEmptyState](packages/viewer/src/components/SidecarEmptyState.tsx), [ErrorState](packages/viewer/src/components/ErrorState.tsx), [DetailMissing](packages/viewer/src/components/DetailMissing.tsx), [ComingSoon](packages/viewer/src/components/ComingSoon.tsx), [ErrorBoundary](packages/viewer/src/components/ErrorBoundary.tsx).

Banners + panels: [CuratorFeed](packages/viewer/src/components/CuratorFeed.tsx), [CorrectionsPanel](packages/viewer/src/components/CorrectionsPanel.tsx), [ActivityLogPanel](packages/viewer/src/components/ActivityLogPanel.tsx), [AnalysisLauncher](packages/viewer/src/components/AnalysisLauncher.tsx), [ActionItemsBanner](packages/viewer/src/components/ActionItemsBanner.tsx), [DataUpdatedBanner](packages/viewer/src/components/DataUpdatedBanner.tsx), [MethodologyDisclosure](packages/viewer/src/components/MethodologyDisclosure.tsx), [SourceAttribution](packages/viewer/src/components/SourceAttribution.tsx).

### Modals / dialogs / sheets

| Component | Pattern | Path |
|---|---|---|
| `DataPanel` | `<aside role="dialog" aria-modal="true">` | [DataPanel.tsx](packages/viewer/src/components/DataPanel.tsx) |
| `DisclosureModal` (chat consent) | `<div role="dialog" aria-modal="true">` + labelledby | [DisclosureModal.tsx](packages/viewer/src/components/modes/chat/DisclosureModal.tsx) |
| `TierSheet` | `<div role="dialog" aria-modal="true">` | [TierSheet.tsx](packages/viewer/src/components/TierSheet.tsx) |
| `InfoPopover` | `role="dialog"` (non-modal) + `aria-haspopup="dialog"` | [InfoPopover.tsx](packages/viewer/src/components/InfoPopover.tsx) |
| `ActivityLogPanel` | `<aside role="dialog">` | [ActivityLogPanel.tsx](packages/viewer/src/components/ActivityLogPanel.tsx) |
| `NuclearReset` | `<aside>` (non-modal dropdown) | [NuclearReset.tsx](packages/viewer/src/components/NuclearReset.tsx) |
| `UploadPanel` | drop-zone (within DataPanel) | [UploadPanel.tsx](packages/viewer/src/components/UploadPanel.tsx) |

---

## 2. A11y infrastructure (existing)

**Maturity: mid-to-high.** 208 `aria-*` attributes, 25 distinct roles, focus-visible used throughout, manual focus management on every modal. Native-button-vs-div-button discipline is documented (see §5) and consistent.

| Concern | Status | Evidence |
|---|---|---|
| `aria-*` coverage | Strong | 208 attrs; aria-label dominant, plus expanded/pressed/current/modal/labelledby/haspopup/controls/busy/disabled/selected/live/relevant |
| `role=` coverage | Strong | 25 distinct: button, status, alert, dialog, list/listitem, tablist/tab/tabpanel, log, banner, region, note, img, table-family, progressbar, toolbar, heading, presentation, none, group |
| `tabIndex` discipline | Good | `0` on every custom button-div (29+ sites); `-1` for focus targets (11+ sites) |
| Screen-reader-only | Two utilities | `.sr-only` at [BaseLayout.astro:135](apps/standalone/src/layouts/BaseLayout.astro#L135); `.lcars-corrections__sr-only` at [styles.css:7078](packages/viewer/src/styles.css#L7078) |
| `:focus-visible` | Comprehensive | 75+ selectors in [styles.css](packages/viewer/src/styles.css); also in AppSidebar.astro and views.astro |
| Focus management | Manual, no library | `setTimeout` focus on dialog open + Escape handlers (DataPanel:96, TierSheet:58, InfoPopover:40, DisclosureModal:52). **No focus trap** — Tab can escape any open dialog. |
| Landmarks | Good | `<main>` on 7+ pages, `<nav aria-label="...">` on 2+, `<header>` 30+, `<footer>` where appropriate |
| **Skip links** | **Missing** | 0 hits for "skip to content" / `#main-content` / similar. Gap. |

**Activation helper (load-bearing):** [a11y.ts](packages/viewer/src/util/a11y.ts) — `onActivate()` wraps Enter + Space for every `<div role="button">`. Used at 17+ component sites.

---

## 3. Color + contrast system

**Source of truth:** CSS custom properties on `.lcars-root` in [styles.css](packages/viewer/src/styles.css) lines 51–83. Exported to [design-system/tokens.json](design-system/tokens.json); documented in [design-system/spec.md](design-system/spec.md).

**Theme model:** Dark-only. No light mode, no `prefers-color-scheme` switching, no `ThemeProvider`. `.lcars-root` is an opt-in wrapper class on the viewer.

| Token | Value | WCAG on `--lcars-bg` (#000) |
|---|---|---|
| `--lcars-sunflower` | `#ffcc99` | 14.3:1 ✅ AAA |
| `--lcars-butterscotch` | `#dd9944` | 8.7:1 ✅ AAA |
| `--lcars-ice` | `#99ccff` | 12.4:1 ✅ AAA |
| `--lcars-violet` | `#cc99cc` | 9.0:1 ✅ AAA |
| `--lcars-peach` | `#ff9933` | 9.9:1 ✅ AAA |
| `--lcars-dim` | `#665544` | 2.9:1 ❌ — placeholder-only by spec |

### Contrast risk candidates (require validation in main loop)

**Hardcoded reds outside the token system** (likely below AA on black):
- [styles.css:2605, 2623, 2720, 2865](packages/viewer/src/styles.css) — `#cc3333`, `#ff6666`, `#ff8866`
- [styles.css:4659, 4676, 4917](packages/viewer/src/styles.css) — `#ff9a6a` (destructive button hover)

**Opacity-dimming on functional text** (each compresses contrast ratio):
- [AppSidebar.astro:417](apps/standalone/src/components/AppSidebar.astro#L417) — `opacity: 0.7` on sidebar count badges
- [AppSidebar.astro:483](apps/standalone/src/components/AppSidebar.astro#L483) — `opacity: 0.85` on "SRC" badge
- [styles.css:2620](packages/viewer/src/styles.css#L2620) — `opacity: 0.7` on transcript timestamps
- [calibrate.astro:236](apps/standalone/src/pages/calibrate.astro#L236) — `opacity: 0.6` on placeholder text
- [personas.astro:457, 499, 526](apps/standalone/src/pages/personas.astro) — `opacity: 0.4` / `0.5` / `0.6`

(Iteration 2 falsifier corrected a baseline error: `index.astro:1400` was previously listed as "opacity 0.5 on hero text"; the actual line is `.today__actions button:disabled { opacity: 0.5 }`, a disabled-control rule that is WCAG-exempt under 1.4.3. Removed from this list.)

### Reviewer note — alpha-on-black contrast math

When a sunflower-alpha hex like `#FFCC9988` sits on a near-black background (`#000` or `#0a0a0a`), the contrast ratio is governed by the composited foreground luminance via sRGB → linear → relative-luminance. Common composited ratios for the LCARS alpha ramp on `#000`:

| Hex | α | Composited ratio | AA normal (4.5:1) | AA UI (3:1) |
|---|---|---|---|---|
| `#FFCC99` | 1.00 | ~13.4:1 | ✅ | ✅ |
| `#FFCC99cc` | 0.80 | ~9.1:1 | ✅ | ✅ |
| `#FFCC9999` | 0.60 | ~5.4:1 | ✅ | ✅ |
| `#FFCC9988` | 0.53 | ~4.4:1 | borderline | ✅ |
| `#FFCC9966` | 0.40 | ~2.8:1 | ❌ | ❌ |
| `#FFCC9955` | 0.33 | ~2.3:1 | ❌ | ❌ |
| `#FFCC9944` | 0.27 | ~1.9:1 | ❌ | ❌ |
| `#FFCC9933` | 0.20 | ~1.55:1 | ❌ | ❌ |
| `#FFCC9922` | 0.13 | ~1.28:1 | ❌ | ❌ |

**Common reviewer mistake:** assuming `alpha × ratio_of_base = effective_ratio`. That's wrong — luminance is non-linear in sRGB, so you must composite first then re-linearize. Iter 3's falsifier got this backwards on five findings (claimed `#FFCC9988` ≈ 7.68:1) and had to be overridden in the fix phase. Always recompute the composited ratio when reviewing alpha values.

**Inline alpha-composited sunflower variants** scattered through `audit.astro`, `index.astro`, `calibrate.astro` (e.g. `#FFCC9911` ≈ 7%, `#FFCC9922` ≈ 13%). Several of these will fail AA.

---

## 4. Typography + readability

**Three-family triad** (no Tailwind; declared in [styles.css:86-88](packages/viewer/src/styles.css#L86) + [BaseLayout.astro:63](apps/standalone/src/layouts/BaseLayout.astro#L63), self-hosted via `@fontsource`):
- Chrome: `'Antonio', 'Oswald', 'Impact', sans-serif`
- Prose: `'IBM Plex Sans', 'Segoe UI', 'system-ui', sans-serif`
- Mono: `'JetBrains Mono', 'Consolas', 'Menlo', monospace`

**Prescribed scale** ([tokens.json:126-162](design-system/tokens.json)): 9 / 10 / 11 / 12 / 13 / 15.5 / 18 px. Body prose floor is **12px**.

**Actual sizes observed:** 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 15.5, 16, 18, 20-26 px.

**Readability risks:**
- **One 8.5px instance** — confirm via review (single grep hit; tracking unclear)
- **9px chrome** is documented as "intentional w/ 0.18em tracking"; spec carves this out. Body prose at 12px is the conformance floor.

**Line-height:** 1.0-1.6. Chrome at 1.0-1.1 (tight for ALL-CAPS), body at 1.4-1.6.

**Max prose width:** `≤640px` typical; one 1200px outlier — line-length compliance overall good.

---

## 5. Interactive primitives

**Native `<button>` count:** 95 sites across 85 files.
**Custom `<div role="button" tabIndex={0}>` pattern:** 37 sites — **documented justification** in [a11y.ts:4-10](packages/viewer/src/util/a11y.ts#L4):
> "Native `<button>` user-agent styles override LCARS background colors in some browsers and a bug in the v7 LCARS iteration forced us off `<button>`."

All div-buttons use `onActivate()` for keyboard support. **This pattern is acceptable as long as the contract is honored.** Files with highest div-button density:
- [FilterBar.tsx](packages/viewer/src/components/FilterBar.tsx) — 7 handlers
- [Sidebar.tsx](packages/viewer/src/components/Sidebar.tsx) — 5
- [DetailMode.tsx](packages/viewer/src/components/modes/DetailMode.tsx) — 4
- [SessionCard.tsx](packages/viewer/src/components/SessionCard.tsx) — 4

**Form elements:** 21 native inputs (file pickers, hidden inputs, search boxes). No custom Combobox/Select/DatePicker.
**Link discipline:** Clean — 0 `<a href="#">` button-impostors detected.

---

## 6. Dynamic content / live regions

**24 `aria-live` regions** (20 polite + 2 assertive + 1 polite-with-aria-relevant):
- Upload + analysis progress: [UploadPanel:229](packages/viewer/src/components/UploadPanel.tsx#L229), [AnalysisLauncher:181](packages/viewer/src/components/AnalysisLauncher.tsx#L181), [ExportMode:352](packages/viewer/src/components/modes/ExportMode.tsx#L352)
- Activity log: [ActivityLogPanel:153](packages/viewer/src/components/ActivityLogPanel.tsx#L153) (`polite` + `aria-relevant="additions"` + `role="log"`)
- Chat streaming: [ChatMode:436](packages/viewer/src/components/modes/ChatMode.tsx#L436)
- Scan errors: [ChatArchViewer:2712, 2736](packages/viewer/src/ChatArchViewer.tsx) (`assertive`)
- Sparkline tooltip values: [Sparkline:359](packages/viewer/src/components/Sparkline.tsx#L359), [OutcomeSparkline:212](packages/viewer/src/components/OutcomeSparkline.tsx#L212)

**Banners:** [DataUpdatedBanner](packages/viewer/src/components/DataUpdatedBanner.tsx), [ActionItemsBanner](packages/viewer/src/components/ActionItemsBanner.tsx); 12 inline `role="alert"` regions in CorrectionsPanel, CuratorFeed, ErrorState.

**Spinners:** `aria-hidden="true"` on the visual element, paired with an external `aria-live="polite"` announcement of the textual state — acceptable pattern.

**Polling sites (skill-driven LLM stages):** corrections / mine-persona / mine-narratives / chat-answer / curate / falsify all poll status JSON files. State changes are announced via `aria-live`, not via `setInterval`-driven DOM swaps — no recurring announcement spam.

---

## 7. Test infrastructure

| Package | testing-lib/jest-dom | testing-lib/react | axe-core | jest-axe | vitest-axe | pa11y |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| root | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| @chat-arch/viewer | ✓ 6.6.0 | ✓ 16.1.0 | ✗ | ✗ | ✗ | ✗ |
| (all others) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

Root has `@vitest/ui`. **No a11y-specific test tooling anywhere in the monorepo. No `*.a11y.test.*` files.**

Configs:
- [packages/viewer/vitest.config.ts](packages/viewer/vitest.config.ts) — jsdom + setup `./test/setup.ts` (loads `fake-indexeddb/auto`)
- [apps/standalone/vitest.config.ts](apps/standalone/vitest.config.ts) — node env, Astro-integrated

**Implication for the main loop:** validation will be limited to lint + existing vitest suites + manual axe-style reasoning. Installing `vitest-axe` mid-loop is a possible side-quest but adds scope risk; defer unless a reviewer explicitly needs it.

---

## 8. Build / lint / test commands

From the repo root:

```
pnpm install --frozen-lockfile     # mirrors CI
pnpm lint                          # monorepo-wide
pnpm test                          # monorepo-wide (vitest)
pnpm build                         # monorepo-wide (all dist/)
```

Per-package alternatives:

```
pnpm --filter @chat-arch/viewer lint
pnpm --filter @chat-arch/viewer test
pnpm --filter @chat-arch/standalone lint
pnpm --filter @chat-arch/standalone test
pnpm --filter @chat-arch/standalone dev   # boots Astro on :4321
```

`pnpm --filter @chat-arch/viewer test` is the **fast inner loop** for component-level changes. Whole-monorepo `pnpm test` covers the analysis kernels.

---

## 9. Risk surfaces

### Components removed since the last refactor

- **BlurredPii — removed in commit [4591dad](https://github.com/) (2026-05-23).** CLAUDE.md still names it as a flagged component, but the file no longer exists. Verify with `git log -- packages/viewer/src/components/BlurredPii.tsx` if a reviewer cites it.

### Hot files (last 30 commits)

| File | Recent commits | A11y review risk |
|---|:-:|---|
| [packages/viewer/src/styles.css](packages/viewer/src/styles.css) | 5 | **High** — touch focus indicators + contrast carefully |
| [packages/viewer/src/components/modes/ProjectsMode.tsx](packages/viewer/src/components/modes/ProjectsMode.tsx) | 5 | **High** — mid-iteration; expect drift |
| [packages/viewer/src/ChatArchViewer.tsx](packages/viewer/src/ChatArchViewer.tsx) | 3 | Medium |

### Implementation patterns that complicate fixes

- **No focus trap library.** Manual implementations on 4 dialogs (DataPanel, TierSheet, InfoPopover, DisclosureModal). Tab key can leak focus out of any open modal. **Likely review finding.**
- **`onActivate()` handles Enter + Space but doesn't normalize Shift+Tab order.** Browser default handles it on real divs, but worth a spot-check for any nested-tabIndex setups.
- **17 source files use the div-role-button pattern.** Any new interactive surface must opt into the same `onActivate()` contract — easy to forget.
- **Hardcoded color values in Astro pages.** `audit.astro` (15), `index.astro` (17), `calibrate.astro` (15), `personas.astro` (multiple opacity-on-text rules). The single-source-of-truth invariant is leaking; review should either pull them into tokens or accept them as semantic status colors with documented contrast.

### Acceptable risk (do NOT regress in fixes)

- **Single dark theme is by design.** Do not introduce light mode or a theme switcher.
- **LCARS chrome under 12px with letter-spacing is by design.** Don't bump label sizes to "fix" a WCAG complaint that doesn't apply to chrome.
- **`<div role="button">` is intentional, not lazy.** Don't refactor to native `<button>` without re-validating LCARS theming.

---

## Review-loop guidance

Suggested per-iteration scope (3-5 surfaces per pass), in priority order:

1. **Modals + focus management** (DataPanel, DisclosureModal, TierSheet, InfoPopover, ActivityLogPanel) — fix the Tab-leak problem; introduce a tiny focus-trap utility.
2. **Skip-link gap** — add a "Skip to main content" affordance in BaseLayout + per-route `<main id="main-content">` discipline.
3. **Hardcoded reds + opacity-dimmed text** — promote to tokens or add justification + measured contrast. Highest-risk site: [index.astro:1400](apps/standalone/src/pages/index.astro#L1400) (`opacity: 0.5` on hero).
4. **8.5px font edge case** — locate + raise to ≥9px or remove.
5. **Astro pages with inline color literals** — `audit.astro`, `calibrate.astro`, `personas.astro`.
6. **Mode-by-mode sweep** — 14 viewer modes. EffectivenessMode + TrendsMode contain the densest chart surfaces; verify sparkline alt-text + table fallbacks.
7. **Hot files** — re-check ProjectsMode + styles.css after each pass since they're under active iteration.
