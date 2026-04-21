# Supergraphic Panel — design system specification

Supergraphic Panel is the visual language of the Chat Archaeologist
viewer ([chat-arch.dev](https://chat-arch.dev)). This document is the
canonical prose specification — terse, declarative, written to be read
by both humans and language-model agents applying the system to a new
project. Every quoted value is cited back to
`packages/viewer/src/styles.css` so a reader can verify the claim at
source. The palette and font families here are extracted from that
stylesheet by a generator script; prescriptive additions (radius,
shadow, duration, font-size scales, status aliases) are authored for
replicators and flagged as such.

Credit where it's due: the direct visual inspiration is Michael
Okuda's LCARS design language for *Star Trek: The Next Generation*
(1987). Unofficial — Supergraphic Panel is not affiliated with or
endorsed by Paramount Pictures or CBS Studios. The broader
supergraphic tradition — Barbara Stauffacher Solomon, Deborah Sussman,
Lance Wyman — supplied additional ideas about flat color planes and
heavy display typography applied at architectural scale. Both are
acknowledgments, not lineage claims; see the Attribution section at
the end for the full posture.

## 1. Vibe

Dark, legible, structurally asymmetric, unapologetically chromed.
Body text sits in a warm sunflower amber on pure black; chrome
elements — labels, bars, pill buttons — carry a butterscotch-on-black
voice with heavy letter-spacing. Shapes are rectangular with
one-corner bends: asymmetric 32–40px elbows where a panel meets a
bar, half-pill rounding (`0 14px 14px 0`) on sidebar tabs, 3px left-
accent rules on cards. Hierarchy comes from color role and surface
stepping, not drop shadows. Motion is deliberate and sparse: a
one-time boot cascade on first paint, 2.2s ring pulses for focus,
80–200ms opacity/background transitions for state. Nothing floats
or glows.

## 2. Structural rules

Tokens are defined on `.lcars-root`, not `:root`
([styles.css:39](../packages/viewer/src/styles.css#L39)). An app
that wants this theme wraps its tree in
`<div class="lcars-root">...</div>`; defining the same variables on
`:root` scopes them globally and breaks any consumer that wants the
theme to be opt-in.

Two instance-local variables are expected to be set inline by
components, not globally:

- `--source-color` — carried by `.lcars-session-card`, `.lcars-source-pill`,
  and downstream children. Defaults to butterscotch
  ([styles.css:1373](../packages/viewer/src/styles.css#L1373)); set per-
  instance via inline style to recolor a card's left accent and pill.
- `--mode-color` — set inline per-instance on each sidebar item from
  React ([Sidebar.tsx:64](../packages/viewer/src/components/Sidebar.tsx#L64)),
  read by the item's own active/hover rules to paint its fill. The
  `.lcars-mode-area` also declares a fallback default of butterscotch
  ([styles.css:1780](../packages/viewer/src/styles.css#L1780)) so the
  variable always resolves even when no mode-area ancestor sets it.

The layout is mobile-first and progressively enhances through three
tiers via `min-width` breakpoints at 600px (tablet) and 900px
(desktop). The desktop tier composes a 2×2 grid where the sidebar
owns a vertical butterscotch arm, the top-bar owns a horizontal
butterscotch arm, and they meet at a square inner corner with rounded
outer corners — the LCARS "L" at rest
([styles.css:432](../packages/viewer/src/styles.css#L432)). Below 320px
the consumer renders a dignified fallback banner
(`.lcars-root--narrow`,
[styles.css:106](../packages/viewer/src/styles.css#L106)).

## 3. Palette with semantic roles

Four accent colors, each with exactly one job. Mixing jobs — e.g.
using ice for a decorative corner — dilutes the system and should
fail code review.

| Token | Hex | Role | Source |
|---|---|---|---|
| `color.sunflower` | `#ffcc99` | Primary text, titles, KPI values, focused states | [L47](../packages/viewer/src/styles.css#L47) |
| `color.sunflower-muted` | `#d9ad82` | Pre-composited inactive sidebar background | [L53](../packages/viewer/src/styles.css#L53) |
| `color.butterscotch` | `#dd9944` | Chrome: labels, top-bar, sidebar elbows | [L54](../packages/viewer/src/styles.css#L54) |
| `color.butterscotch-muted` | `#6a4a20` | Muted chrome for inactive mobile pill-bar items | [L55](../packages/viewer/src/styles.css#L55) |
| `color.ice` | `#99ccff` | Quantitative: model names, inline code, data | [L56](../packages/viewer/src/styles.css#L56) |
| `color.violet` | `#cc99cc` | Thinking, processing, streaming | [L57](../packages/viewer/src/styles.css#L57) |
| `color.peach` | `#ff9933` | Cost and error accent | [L58](../packages/viewer/src/styles.css#L58) |
| `color.bg` | `#000000` | Root frame | [L59](../packages/viewer/src/styles.css#L59) |
| `color.bg-1` | `#07070a` | Card / panel surface | [L60](../packages/viewer/src/styles.css#L60) |
| `color.bg-2` | `#0d0d12` | Card hover surface | [L61](../packages/viewer/src/styles.css#L61) |
| `color.dim` | `#665544` | Inert placeholder glyphs only (em-dashes, missing values) | [L63](../packages/viewer/src/styles.css#L63) |
| `color.divider` | `rgba(221, 153, 68, 0.18)` | Panel and card borders | [L64](../packages/viewer/src/styles.css#L64) |

Prescriptive status aliases (`status.concept` → violet,
`status.active` → sunflower, `status.open-pr` → ice,
`status.merged` → butterscotch, `status.released` → peach) map a
generic product-state progression onto the same palette without
introducing new pigments.

## 4. WCAG contrast matrix

All ratios computed against `color.bg` (`#000000`) except where
noted. AA requires ≥ 4.5:1 for body text, AAA ≥ 7:1.

| Pair | Ratio | AA body | AAA body | Notes |
|---|---|---|---|---|
| sunflower on bg | 14.3:1 | ✅ | ✅ | Default body text. |
| butterscotch on bg | 8.7:1 | ✅ | ✅ | Chrome labels. |
| ice on bg | 12.4:1 | ✅ | ✅ | Model names, code. |
| violet on bg | 9.0:1 | ✅ | ✅ | Thinking state. |
| peach on bg | 9.9:1 | ✅ | ✅ | Errors, cost. |
| dim on bg | 2.9:1 | ❌ | ❌ | **Decorative only.** Inert glyphs. |
| bg on sunflower-muted | 10.2:1 | ✅ | ✅ | Inactive sidebar item: black text on muted amber. |
| bg on butterscotch | 8.7:1 | ✅ | ✅ | Active sidebar tab, mid-bar label. |
| sunflower on butterscotch-muted | 5.5:1 | ✅ | ❌ | Mobile pill-bar inactive state. AA only. |

The `sunflower-muted` token exists specifically to hold 10.2:1 for
black text regardless of what sits behind the sidebar item — an
earlier implementation used `butterscotch × opacity 0.55` and fell
to 3.1:1 when the backdrop shifted. The fix was a pre-composited
solid color
([styles.css:1057](../packages/viewer/src/styles.css#L1057)). Replicators
should pre-composite by hand rather than rely on `opacity` whenever
legibility is load-bearing.

## 5. Typography

Three families, each with one role. Do not cross roles.

| Family | Use | Stack |
|---|---|---|
| Antonio | Chrome, ALL-CAPS labels, titles, pills, KPI values | `'Antonio', 'Oswald', 'Impact', sans-serif` |
| IBM Plex Sans | Body prose inside cards and messages | `'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif` |
| JetBrains Mono | Model names, timestamps, code, keyboard hints | `'JetBrains Mono', 'Consolas', 'Menlo', monospace` |

All three are licensed under the **SIL Open Font License 1.1** and may
be redistributed. The viewer imports them from Google Fonts
([styles.css:37](../packages/viewer/src/styles.css#L37)); self-hosting
is equivalent. Weights loaded: Antonio 400/500/600/700, IBM Plex Sans
400/500/600, JetBrains Mono 400/500/600.

Chrome type carries heavy tracking: `letter-spacing: 0.14em` on pills
and source buttons, `0.16em–0.22em` on titles and group labels. Without
the tracking, Antonio caps read cramped at small sizes. `line-height:
1` with a 1–3px `padding-bottom` correction is the idiomatic way to
keep Antonio caps optically centered in fixed-height pill chrome — the
font's baseline sits low in the em-box and naive centering paints caps
below the visual center. See the source-pill badge
([styles.css:1428](../packages/viewer/src/styles.css#L1428)) for the
canonical treatment.

## 6. Component patterns

Eight patterns. Each lists the class combination, a minimal markup
example, and one usage rule. All selectors assume an ancestor with
class `lcars-root`.

### 6.1 Top bar

```html
<header class="lcars-top-bar">
  <div class="lcars-top-bar__left">
    <span class="lcars-top-bar__dot"></span>
    <h1 class="lcars-top-bar__title">CHAT ARCHAEOLOGIST</h1>
  </div>
</header>
```

Rule: `border-radius: 0 16px 16px 0` — rounded at the right end
only, squared off to meet the sidebar's top elbow
([styles.css:465](../packages/viewer/src/styles.css#L465)).

### 6.2 Sidebar tab (desktop)

```html
<li class="lcars-sidebar__item lcars-sidebar__item--active"
    style="--mode-color: var(--lcars-ice)">
  <span class="lcars-sidebar__item-short">01</span>
  <span class="lcars-sidebar__item-label">COMMAND</span>
</li>
```

Rule: `border-radius: 0 18px 18px 0` — half-pill, rounded on the
side away from the sidebar. The active tab paints in its
`--mode-color`; hovers over inactive tabs preview that color
([styles.css:1140](../packages/viewer/src/styles.css#L1140)).

### 6.3 Source pill

```html
<button class="lcars-source-pill lcars-source-pill--active"
        style="--source-color: var(--lcars-ice)">
  <span class="lcars-source-pill__badge">CC</span>
  <span class="lcars-source-pill__label">CLAUDE CODE</span>
  <span class="lcars-source-pill__count">247</span>
</button>
```

Rule: the pill sizes itself to content. Never truncate with ellipsis
— an earlier revision that did so clipped `CLI-DESKTOP` on narrow
viewports
([styles.css:1396](../packages/viewer/src/styles.css#L1396)).

### 6.4 Session card

```html
<article class="lcars-session-card"
         style="--source-color: var(--lcars-ice)">
  <div class="lcars-session-card__row lcars-session-card__row--top">
    <!-- source-pill, project label, time -->
  </div>
  <h2 class="lcars-session-card__title">Refactor the exporter</h2>
  <p class="lcars-session-card__preview">...</p>
</article>
```

Rule: the card's left edge is a 3px accent rule in its
`--source-color`
([styles.css:1866](../packages/viewer/src/styles.css#L1866)). Hover
lifts the card with `transform: translateY(-1px)` and tints the
surface 5% toward sunflower — never with a drop shadow.

### 6.5 Info popover

```html
<div class="lcars-info-popover">
  <button class="lcars-info-popover__trigger">i</button>
  <div class="lcars-info-popover__panel">
    <strong>HEADING</strong>
    <p>Body prose in IBM Plex Sans.</p>
  </div>
</div>
```

Rule: the panel is the only in-system use of a drop shadow
(`0 10px 40px rgba(0,0,0,0.6)`), because it floats above the frame.
Otherwise the system does not use shadows
([styles.css:710](../packages/viewer/src/styles.css#L710)).

### 6.6 Mid bar

```html
<div class="lcars-mid-bar" style="background: var(--lcars-butterscotch)">
  <span class="lcars-mid-bar__label">BROWSE / COMMAND</span>
</div>
```

Rule: 20–26px tall solid butterscotch strip, black label type,
`border-radius: 10–13px`. Acts as a horizontal separator that still
reads as chrome
([styles.css:1750](../packages/viewer/src/styles.css#L1750)).

### 6.7 Rescan banner

```html
<div class="lcars-rescan-banner lcars-rescan-banner--ok">
  <span class="lcars-rescan-banner__tag">OK</span>
  <span class="lcars-rescan-banner__message">Rescan complete.</span>
  <button class="lcars-rescan-banner__dismiss">×</button>
</div>
```

Rule: status communicated by a 4px left-border accent
(`--ok` → ice, `--error` → peach, `--demo` → butterscotch), not by
tinting the whole surface
([styles.css:843](../packages/viewer/src/styles.css#L843)).

### 6.8 Semantic chip

```html
<button class="lcars-semantic-chip lcars-semantic-chip--ready">
  <span class="lcars-semantic-chip__label">TOPICS READY</span>
</button>
```

Rule: chip state is carried by border + foreground color, not by
surface fill. Five states: `--cta` (action), `--running` (violet,
animated), `--ready` (ice), `--error` (peach), `--stale`
(butterscotch)
([styles.css:2791](../packages/viewer/src/styles.css#L2791)).

## 7. Motion language

The system defines many `@keyframes` in `styles.css` (17 total);
the named keyframes replicators most need to know about are:

- `lcars-boot-online` — one-time "coming online" cascade across the
  top-bar, sidebar, upper panel, filter bar, and mode area. Total
  duration ~1400ms, played once when data first arrives
  ([styles.css:205](../packages/viewer/src/styles.css#L205)).
- `lcars-filter-streaming-pulse` — 1.6s infinite pulse on the
  project-pill row's left border while semantic analysis is running
  ([styles.css:344](../packages/viewer/src/styles.css#L344)).
- `lcars-filter-focus-pulse-ice` / `lcars-filter-focus-pulse-violet` —
  2.2s double-flash that fires once when the user navigates here
  from an analysis card
  ([styles.css:371](../packages/viewer/src/styles.css#L371)).
- `lcars-info-popover-in` / `lcars-rescan-banner-in` — 140–200ms
  enter animations for floating surfaces.
- `lcars-source-btn-pulse` / `lcars-semantic-chip-pulse` — slow
  infinite pulses on long-running-state indicators.

Focus is communicated with **ring pulses** (`box-shadow: 0 0 0 3px
color-mix(...)`), not glow or outline. Hover on cards is a
`translateY(-1px)` lift with a surface tint, never a shadow.

**`prefers-reduced-motion: reduce` policy.** All decorative motion
is disabled under reduced-motion. The source honors this at the boot
cascade ([styles.css:277](../packages/viewer/src/styles.css#L277)),
filter-bar pulses
([styles.css:348](../packages/viewer/src/styles.css#L348) and
[L399](../packages/viewer/src/styles.css#L399)), sparkline tooltip
([L1706](../packages/viewer/src/styles.css#L1706)), tier indicator
([L3000](../packages/viewer/src/styles.css#L3000)), and several
others. Essential state transitions (≤100ms background / opacity
changes on hover, focus) remain at full speed — they carry
information, not decoration. Replicators porting the system MUST
honor `prefers-reduced-motion: reduce` on any non-trivial animation.

## 8. What not to do

- **Don't define tokens on `:root`.** Use `.lcars-root`. Tokens on
  `:root` leak into the consumer's global scope.
- **Don't add drop shadows.** Floating popovers (info-popover,
  rescan-banner, tier-sheet backdrop) are the only exception.
  In-frame cards and panels derive hierarchy from surface stepping
  (`bg` → `bg-1` → `bg-2`) and border color.
- **Don't introduce a fourth font.** Antonio / IBM Plex Sans /
  JetBrains Mono is the triad. Adding a display serif or a geometric
  sans breaks the voice.
- **Don't soften the asymmetric radii** into four-corner-equal
  corners. The L-corner elbow (`32px 0 0 0` / `0 0 0 32px`) and the
  half-pill (`0 14px 14px 0`) are the signature shapes.
- **Don't use `#665544` (dim) for body text.** It fails AA. It is
  for inert glyphs only.
- **Don't put butterscotch on bg for long paragraphs.** Butterscotch
  is chrome, not prose. Paragraph text should be `color.text`
  (sunflower-equivalent) or `color.sunflower`.
- **Don't mix type roles.** Antonio for chrome, IBM Plex Sans for
  prose, JetBrains Mono for data. Cross-role usage is a code smell.
- **Don't tint `color.divider`.** It's already a low-alpha
  butterscotch; re-tinting stacks the mix and reads as a full stroke.

## 9. Port recipes

### Plain CSS

Import `@chat-arch/viewer/style.css` verbatim and wrap the app in
`.lcars-root`:

```html
<link rel="stylesheet" href="/path/to/chat-arch-viewer/style.css" />
<div class="lcars-root">
  <header class="lcars-top-bar">...</header>
</div>
```

All tokens, components, and media queries come along automatically.

### Tailwind v4 `@theme`

```css
@import "tailwindcss";

@theme {
  --color-sunflower: #ffcc99;
  --color-butterscotch: #dd9944;
  --color-ice: #99ccff;
  --color-violet: #cc99cc;
  --color-peach: #ff9933;
  --color-bg: #000000;
  --color-bg-1: #07070a;
  --color-bg-2: #0d0d12;
  --color-dim: #665544;

  --font-chrome: 'Antonio', 'Oswald', 'Impact', sans-serif;
  --font-prose: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Consolas', 'Menlo', monospace;

  --radius-elbow: 32px;
  --radius-pill: 14px;
}
```

Then compose with utilities: `bg-bg-1 border-l-[3px] border-ice
font-prose text-sunflower`. Custom components (elbow radii,
source-pills) still want a small CSS layer — Tailwind doesn't
express asymmetric radii ergonomically.

### CSS-in-JS (emotion / styled-components)

```ts
export const theme = {
  colors: {
    sunflower: '#ffcc99',
    butterscotch: '#dd9944',
    ice: '#99ccff',
    violet: '#cc99cc',
    peach: '#ff9933',
    bg: '#000000',
    bg1: '#07070a',
  },
  fonts: {
    chrome: "'Antonio', 'Oswald', 'Impact', sans-serif",
    prose: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
    mono: "'JetBrains Mono', 'Consolas', 'Menlo', monospace",
  },
  radii: { elbow: '32px', pill: '14px' },
};

const Card = styled.article`
  background: ${(p) => p.theme.colors.bg1};
  border-left: 3px solid ${(p) => p.theme.colors.ice};
  border-radius: 8px;
  padding: 10px 12px;
  &:hover { transform: translateY(-1px); }
`;
```

## 10. Attribution, copyright, and trademark posture

**Direct visual inspiration:** Michael Okuda's LCARS
(Library Computer Access/Retrieval System) design language, created
for *Star Trek: The Next Generation* (1987) and extended across
subsequent Trek series. The asymmetric elbow, the dark background
with bright chrome bars, the heavy-tracked display-sans labeling,
and the semantic color discipline are Okuda-derived.

**Additional inspiration:** the broader supergraphic tradition — the
environmental-scale flat-color work of Barbara Stauffacher Solomon
(Sea Ranch, 1960s), Deborah Sussman (Sussman/Prejza, 1984 Los
Angeles Olympics), and Lance Wyman (Mexico 68). Their contribution
is a source of ideas about applying heavy display typography and
unmixed color planes at architectural scale. This is an
acknowledgment, not a claim of continuity.

**Trademark posture.** `Supergraphic Panel` is not affiliated with or
endorsed by Paramount Pictures or CBS Studios. The implementation
(`packages/viewer/src/styles.css` in the chat-arch repository)
contains no copyrighted assets, trademarked logos, or proprietary
show-associated iconography from *Star Trek* or any other protected
work. Color values, shape primitives, and font choices are
functional design elements and, under prevailing design-community
custom, not proprietary.

This posture is design-community custom, not legal advice.
Replicators who wish to adopt the system commercially should run
their own counsel over it.
