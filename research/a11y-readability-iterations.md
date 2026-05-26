# Accessibility + Readability Review Loop — Iteration Log

Companion to [a11y-readability-baseline.md](a11y-readability-baseline.md). Each iteration:
scope → reviewer findings → falsifier verdicts → fixes applied → validation outcome.

---

## Iteration 1 — Modals + focus management (2026-05-26)

**Scope (5 surfaces):**
- [DataPanel.tsx](../packages/viewer/src/components/DataPanel.tsx)
- [DisclosureModal.tsx](../packages/viewer/src/components/modes/chat/DisclosureModal.tsx)
- [TierSheet.tsx](../packages/viewer/src/components/TierSheet.tsx)
- [InfoPopover.tsx](../packages/viewer/src/components/InfoPopover.tsx)
- [ActivityLogPanel.tsx](../packages/viewer/src/components/ActivityLogPanel.tsx)

**Reviewer counts:**
| Reviewer | Framing | Raw findings |
|---|---|---|
| A | WCAG 2.2 AA strict | 14 |
| B | Screen-reader simulator | 24 |
| C | Readability + visual hierarchy | 12 |
| | **Total raw** | **~50** |

**Falsifier verdicts (39 deduplicated F-IDs):**
- Verified: 32
- Duplicate-of-prior: 4 (focus-trap × 2 + focus-restore × 2 collapse into shared utility)
- Unverified: 3 (F23 contrast math wrong; F35 + F36 — button-text content differentiates, not color-only)

**Fixes applied (this iteration):**

| F-ID | File | Change |
|---|---|---|
| F1, F2, F3 | [util/a11y.ts](../packages/viewer/src/util/a11y.ts) | NEW `useFocusTrap(active, container, initialFocus?)` hook — Tab cycles last↔first, focus restore on close. |
| F1, F4 | [DataPanel.tsx](../packages/viewer/src/components/DataPanel.tsx) | Adopt `useFocusTrap` with `closeButtonRef` as initial focus; dialog gets `ref={dialogRef}`. |
| F9 | DataPanel.tsx | `aria-label="data sources panel"` → `aria-labelledby="lcars-data-panel-title"` on the h2. |
| F1, F4, F5, F12, F13 | [DisclosureModal.tsx](../packages/viewer/src/components/modes/chat/DisclosureModal.tsx) | Adopt `useFocusTrap` with `cancelRef` initial focus (consent-gate safer default); backdrop `aria-hidden="true"`. |
| F1, F4, F6 | [TierSheet.tsx](../packages/viewer/src/components/TierSheet.tsx) | Adopt `useFocusTrap(true, rootRef, closeRef)`; dialog `tabIndex={-1}`. |
| F10 | TierSheet.tsx | `aria-label="Analysis tier details"` → `aria-labelledby="lcars-tier-sheet-title"`. |
| F30, F37 | TierSheet.tsx | Split ~900-char single `<p>` into two paragraphs each preceded by `<h3 class="lcars-tier-sheet__subhead">`. |
| F31 | TierSheet.tsx | Drop redundant `'present'` text fallback in timestamp span (icon already announces). |
| F14, F15 | [InfoPopover.tsx](../packages/viewer/src/components/InfoPopover.tsx) | Trigger `aria-label` becomes `info — {ariaLabel}` (resolves "i" visible-vs-name mismatch); panel `aria-label` becomes `{ariaLabel} — details` (differentiates the two roles). |
| F4, F7, F11 | [ActivityLogPanel.tsx](../packages/viewer/src/components/ActivityLogPanel.tsx) | Adopt `useFocusTrap(isOpen, panelRef, closeRef)`; `aria-label` → `aria-labelledby`. |
| F28 (partial) | ActivityLogPanel.tsx | Drop redundant `aria-live="polite"` + `aria-relevant="additions"` from the list — keep `role="log"` for SR opt-in review (role's implicit semantics handle the live behavior without double-declaring). |
| F32 | ActivityLogPanel.tsx | Add `<span className="lcars-sr-only">{severity}:</span>` before time so SRs announce severity (glyph stays `aria-hidden`). |
| F33 | ActivityLogPanel.tsx | Remove `<br />` from empty-state paragraph; let CSS wrapping handle it. |
| F39 | ActivityLogPanel.tsx | Add `aria-label={isoTimestamp}` to time span so keyboard/SR users get full ISO (previously hover-only via `title`). |
| F16 | [styles.css](../packages/viewer/src/styles.css) `.lcars-data-panel__close` | `padding: 2px 7px` → `6px 10px` + `min-width: 28px; min-height: 28px` + visible focus-outline ring. |
| F17 | styles.css `.lcars-activity-log__action,__close` | `padding: 3px 8px` → `7px 10px` + `min-width: 28px; min-height: 28px` + visible focus-outline. |
| F18 | styles.css `.lcars-chat-disclosure__cancel,__confirm` | NEW `:focus-visible` rule (2px ice outline + offset); also `font-size: 11px → 12px`, `padding: 8px 14px → 10px 16px`, `min-height: 36px` (also addresses the design judgment on tiny consent CTAs). |
| F19 | styles.css `.lcars-tier-sheet__close:focus-visible` | Replace `outline: none` with `outline: 2px solid var(--lcars-sunflower); outline-offset: 2px`. |
| F20 | styles.css `.lcars-activity-log__empty` | `opacity: 0.45` → `0.7`. |
| F21 | styles.css `.lcars-activity-log__time` | `opacity: 0.55` → `0.75`. |
| F22 | styles.css `.lcars-activity-log__entry--debug` | `opacity: 0.6` → `0.75`. |
| F24 | styles.css `.lcars-tier-sheet__hint` | `font-size: 11px + opacity: 0.85` → `font-size: 12px` (no opacity dim); `line-height: 1.5` → `1.55`. |
| F25 | styles.css `.lcars-tier-sheet__desc` | `font-size: 11px + opacity: 0.75` → `font-size: 12px + opacity: 0.9` + explicit `line-height: 1.4`. |
| F26 | styles.css `.lcars-info-popover__panel code` | `font-size: 11.5px` → `12px`. |
| F27 | styles.css `.lcars-activity-log__list` | `font-size: 11px` → `12px`; `line-height: 1.4` → `1.45`. |
| F38 | styles.css `.lcars-tier-sheet__item` | `border: 1px solid var(--lcars-dim)` (2.9:1) → `color-mix(in srgb, var(--lcars-butterscotch) 35%, transparent)` (compliant with 1.4.11). |
| (utility) | styles.css | Added `.lcars-sr-only` generic utility (alongside `.lcars-corrections__sr-only`) — single rule definition. |

**Tests updated to match new contracts (not regressions):**
- [TierSheet.test.tsx:55-68](../packages/viewer/src/components/TierSheet.test.tsx#L55) — assertion rewritten from "expects 'present' text" to "expects icon with aria-label='present'" (matches the new no-duplicate-announce behavior).
- [ChatArchViewer.test.tsx:611](../packages/viewer/src/ChatArchViewer.test.tsx#L611) — `getByRole('dialog', { name: /data sources panel/i })` → `getByRole('dialog', { name: /^DATA$/ })` (matches the new `aria-labelledby` name, which is the visible h2 contents).

**Validation:**
- `pnpm --filter @chat-arch/viewer lint`: 0 errors, 6 pre-existing warnings (unused eslint-disable directives elsewhere).
- `pnpm --filter @chat-arch/viewer test`: **582/582 pass** ✅
- `pnpm --filter @chat-arch/standalone lint`: 0 errors, 1 pre-existing warning.
- `pnpm --filter @chat-arch/standalone test`: **306/306 pass** ✅

**Deferred to a later iteration:**
- **F29** (DataPanel UPLOAD state silent change) — fix is non-surgical (new sr-only status region or dynamic aria-label re-announce strategy). Belongs in a focused "dynamic-state announcement" iteration covering the live-region story across UPLOAD CLOUD / SCAN LOCAL / analysis launcher in one pass.
- **F34** (ActivityLogPanel `role="dialog"` without aria-modal on a non-modal panel) — semantic role change (`role="dialog"` → `role="complementary"`) likely affects a few tests + the panel's keyboard contract. Worth doing alongside a broader landmark-discipline iteration covering `<aside>` semantics across the viewer.
- The two unverified findings (F23 contrast math, F35/F36 button differentiation) — not actionable.

**Surfaces cleaned this iteration (skip-in-next-iteration list):**
- DataPanel
- DisclosureModal
- TierSheet
- InfoPopover
- ActivityLogPanel

A future iteration may revisit these for F29 + F34 (the two known-deferred items) and for new findings introduced by the wider context (e.g. landmark hierarchy issues that only become visible when the iteration scope includes pages, not just modals).

---

## Iteration 2 — Skip-links + landmark hygiene (2026-05-26)

**Scope (5 surfaces):**
- [BaseLayout.astro](../apps/standalone/src/layouts/BaseLayout.astro) — page shell
- [AppSidebar.astro](../apps/standalone/src/components/AppSidebar.astro) — primary nav rail
- [index.astro](../apps/standalone/src/pages/index.astro) — TODAY feed (most-visited)
- [sessions.astro](../apps/standalone/src/pages/sessions.astro) — viewer mount point
- [TopBar.tsx](../packages/viewer/src/components/TopBar.tsx) — in-viewer banner chrome

**Reviewer counts:**
| Reviewer | Framing | Raw findings |
|---|---|---|
| A | WCAG 2.2 AA strict | 17 |
| B | Screen-reader simulator | 20 |
| C | Readability + visual hierarchy | 15 |
| | **Total raw** | **~52** |

**Falsifier verdicts (25 deduplicated F-IDs):**
- Verified: 24
- Unverified: 1 (F25 — alpha "inconsistency" between source-btn vs search input was actually two different `@media` breakpoint contexts)
- Baseline-doc bug found + corrected (F19): line `index.astro:1400` was wrongly labeled as "opacity 0.5 on hero text" — actually a `:disabled` rule (WCAG-exempt). Updated [baseline doc §3](a11y-readability-baseline.md).

**Fixes applied (this iteration):**

### Bundle 1 — landmark hygiene + skip-link (F1+F2+F13+F20+F21+F5+F22+F23)

| F-ID | File | Change |
|---|---|---|
| F1 | [BaseLayout.astro](../apps/standalone/src/layouts/BaseLayout.astro) | NEW `<a class="skip-link" href="#main-content">Skip to main content</a>` as first child of `<body>`; new `.skip-link` CSS rule (translate-Y-100% until `:focus`, then high-contrast slide-in). |
| F2 | BaseLayout.astro | `hideSidebar` branch now wraps slot in `<main id="main-content" class="app-shell__main" tabindex="-1">`. With-sidebar branch keeps the `<div>` wrapper so per-page `<main>` discipline survives (the viewer mounts its own `<main>` on `/sessions` — wrapping again would re-create the nested-main problem this iteration is fixing). |
| F4 | BaseLayout.astro | Hardcoded hex literals (`#000`, `#FFCC99`, `#FF9933`) replaced with a `:root { --lcars-bg / --lcars-sunflower / --lcars-peach }` block referenced via `var(…)`. |
| F3 | BaseLayout.astro | `title` prop now defaults to `'Chat Archaeologist'`. |
| F13 | [index.astro](../apps/standalone/src/pages/index.astro) | `<main class="today">` → `<main id="main-content" class="today" tabindex="-1">`. |
| F20+F21 | [sessions.astro](../apps/standalone/src/pages/sessions.astro) | Dropped outer `<main>` wrapper; replaced with `<div id="main-content" tabindex="-1">`. Viewer's internal `<main>` now provides the landmark — exactly one `<main>` per `/sessions` deep-link route. |
| F5 | [AppSidebar.astro](../apps/standalone/src/components/AppSidebar.astro) | `<aside class="app-sidebar" aria-label="Primary">` → `<nav class="app-sidebar" aria-label="Primary">`. Closing `</aside>` → `</nav>`. |
| F22 | [TopBar.tsx](../packages/viewer/src/components/TopBar.tsx) | Dropped `role="banner"` from `<header className="lcars-top-bar">` — when mounted inside `<main>` (the viewer's path), `role="banner"` violates landmark hierarchy. |
| F23 | TopBar.tsx | `<h1 className="lcars-top-bar__title">CHAT ARCHAEOLOGIST</h1>` → `<div className="lcars-top-bar__title">…</div>`. Pages now own their own H1. |

### Bundle 2 — index.astro heading promotion (F12+F14)
- Five `<span class="today__bar-key" id="sec-{brief,new,act,broken,stories}">` promoted to `<h2 class="today__bar-key" id="…">`. Section `aria-labelledby` already pointed at these ids — chain stays intact.
- `<h2>CORPUS HEALTH</h2>` got `id="sec-corpus-health"` + parent `<section aria-labelledby="sec-corpus-health">` for consistency with the five sibling sections.
- `.today__bar-key` CSS rule gained `margin: 0` to reset the default `<h2>` margin so the bar pill layout is unchanged.

### Bundle 3 — AppSidebar collapsed labels (F6+F11)
- Each `<a class="app-sidebar__item">` gained `aria-label={item.label}` — full label survives the collapsed state's `display: none` on the visible label span. Same for the TODAY top anchor.
- VIEW SOURCE link gained `aria-label="View source on GitHub"` so the accessible name survives when the visible "VIEW SOURCE ↗" span is hidden.

### Bundle 4 — AppSidebar group labels (F7)
- Group `<div class="app-sidebar__group">` gained `role="group" aria-labelledby={groupId}`; the inner group-label `<div>` gained `id={groupId}` and dropped `aria-hidden="true"`. ARCHIVE / WORKSHOP / SYSTEM are now SR-discoverable boundaries.

### Bundle 5 — aria-expanded discipline (F8)
- Removed the hardcoded `aria-expanded="true"` from the toggle button markup. `attachCollapse()` (boot script) already sets `aria-expanded` in `apply()` (script L56-58); the literal markup attribute was a lie on mobile and when `localStorage.collapsed = true`.

### Bundle 6 — progress-bar ARIA (F15)
- `#progress-bar` div gained `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow="0"`, `aria-label="scan progress"`. `setPhase()` JS now updates `aria-valuenow` alongside the visual bar fill so SR users hear the percentage.

### Bundle 7 — TopBar rescan-delta breakdown (F24)
- `aria-label` now carries the full per-source breakdown (cowork / CLI / desktop counts) instead of only the total. `title=` kept as supplementary mouse-hover tooltip.

### Bundle 8 — index.astro card font-size (F18)
- `.today__card-score`: `font-size: 10px` → `12px`.
- `.today__curator-rank`: `font-size: 11px` → `12px`.
- `.today__story-date`: `font-size: 11px` → `12px`.

### Bundle 9 — AppSidebar cosmetic opacity (F9+F10)
- Dropped `opacity: 0.7` on `.app-sidebar__item-short` (the dim was cosmetic — collapsed-state override already bumped to 1).
- Dropped the now-unused `opacity: 1` collapsed override.
- Dropped `opacity: 0.85` on `.app-sidebar__source-short`.

### Bundle 10 — brief-md keyboard scroll (F17)
- `<pre class="today__brief-md">` gained `tabindex="0"` (both render branches).
- New `:focus-visible` rule on `.today__brief-md` (2px ice outline) so the keyboard-reachable boundary is visible.

### Misc
- F4 + F3 + F19 covered above.
- F16 (104 hardcoded hex literals in `index.astro`) **DEFERRED to iteration 3** as the "Astro inline-color sweep" — same problem present in `audit.astro` / `calibrate.astro` / `personas.astro`. Belongs in its own iteration scoped to token-system reconciliation.

**Tests updated to match new contracts (not regressions):**
- [empty-state-contracts.test.ts:87-89](../apps/standalone/test/pages/empty-state-contracts.test.ts#L87) — regex updated from `<span class="today__bar-key"` → `<h2 class="today__bar-key"` (matches F12).
- [AppSidebar.test.ts:176-182](../apps/standalone/test/components/AppSidebar.test.ts#L176) — assertion shifted from "aria-expanded='true' in markup" to "aria-controls links to the body region", with a comment explaining F8.

**Validation:**
- `pnpm --filter @chat-arch/viewer lint`: 0 errors, 6 pre-existing warnings.
- `pnpm --filter @chat-arch/viewer test`: **582/582 pass** ✅
- `pnpm --filter @chat-arch/standalone lint`: 0 errors, 1 pre-existing warning.
- `pnpm --filter @chat-arch/standalone test`: **306/306 pass** ✅

**Deferred to a later iteration:**
- **F16** (~104 hardcoded hex literals in `index.astro` outside the token system, plus the same problem in `audit.astro` / `calibrate.astro` / `personas.astro`) — natural fit for a dedicated "Astro inline-color sweep" iteration. The fix is mechanical but large; doing it inline here would dwarf the rest of the bundle.
- **F19** baseline-doc errata applied directly (not deferred).
- **F25** unverified — dropped.

**Surfaces cleaned this iteration (skip-in-next-iteration list):**
- BaseLayout
- AppSidebar
- TopBar
- sessions.astro
- index.astro (with F16 carve-out — the heading + landmark + font-size + tabindex fixes shipped, but the inline-color sweep is a separate concern)

Carry-over from iter 1 still open: F29 (DataPanel UPLOAD silent state), F34 (ActivityLogPanel `role="dialog"` vs `role="complementary"`). Iter 2 found no fresh cause to revisit modals.

---

## Iteration 3 — Astro inline-color sweep + contrast (2026-05-26)

**Scope (4 surfaces + 1 spot-check):**
- [audit.astro](../apps/standalone/src/pages/audit.astro)
- [calibrate.astro](../apps/standalone/src/pages/calibrate.astro)
- [personas.astro](../apps/standalone/src/pages/personas.astro)
- [index.astro](../apps/standalone/src/pages/index.astro) (F16 carry-over from iter 2 — heading + landmark + font work shipped; ~104 inline colors still open)
- [styles.css](../packages/viewer/src/styles.css) spot-check for the rumored 8.5px font

**Reviewer counts:**
| Reviewer | Framing | Raw findings |
|---|---|---|
| A | WCAG 2.2 AA strict | 21 |
| B | Screen-reader simulator | 20 |
| C | Readability + visual hierarchy | 18 |
| | **Total raw** | **~59** |

**Falsifier verdicts (31 canonical F-IDs):**
- Verified: 17 (the falsifier marked 12, but I overrode 5 it had wrongly dropped — see math note below)
- Unverified: 5 (F22, F24 turned out verified after recomputing; F7, F8, F10 were also borderline-verified)
- Duplicate / acceptable-risk-regress / dropped: 4 (F23, F29, F30, F31)
- Carry-over deferred: F13, F15, F16, F17, F18 (calibrate ARIA polish), F27 (personas markdown render) — deferred to iter 4

**Falsifier math correction:** the iter-3 falsifier systematically computed alpha-on-black contrast wrong (claimed `#FFCC9988` ≈ 7.68:1 when actual ≈ 4.4:1). I caught the error in the fix phase, recomputed using sRGB → linear → relative-luminance, and applied bumps the falsifier had skipped. **New baseline doc section: "Reviewer note — alpha-on-black contrast math"** with a lookup table so the next iteration's reviewer + falsifier don't repeat the mistake.

**Fixes applied (this iteration):**

### Bundle A — skip-link target gap (3 one-line fixes)
- [audit.astro:92](../apps/standalone/src/pages/audit.astro#L92) `<main class="audit">` → `<main id="main-content" class="audit" tabindex="-1">`.
- [calibrate.astro:7](../apps/standalone/src/pages/calibrate.astro#L7) — same shape.
- [personas.astro:131](../apps/standalone/src/pages/personas.astro#L131) — same shape.

Iter 2 shipped the skip-link in BaseLayout but only fixed `sessions.astro` and `index.astro` to provide the `#main-content` target. These three pages had a broken skip-link. Now closed across all five iter-3 Astro surfaces + iter-2's two.

### Bundle G — pass/fail/warn semantic token promotion (F4)
- [BaseLayout.astro](../apps/standalone/src/layouts/BaseLayout.astro) `:root` block now declares `--lcars-pass: #88e088` / `--lcars-fail: #f08080` / `--lcars-warn: #ffd680`.
- [audit.astro](../apps/standalone/src/pages/audit.astro) badge colors (`.badge--pass / --fail / --inconc`) updated to reference the new tokens.
- [calibrate.astro](../apps/standalone/src/pages/calibrate.astro) `.calibrate__btn--y / --n` borders + text + `.calibrate__error` + `.calibrate__error-detail` border-left use the new tokens.
- Three pages previously each re-authored the same green/red palette inline. Now one source of truth.
- (Inline JS in index.astro:891 — `status.style.color = isError ? '#f08080' : '#88e088'` — left as literals with a TODO since `style.color` can't cleanly reference CSS vars; reasonable carry-over for an iter that introduces a status class instead.)

### Bundle D — contrast violations (verified WCAG fails)

| F-ID | Site | Change |
|---|---|---|
| F5 | [personas.astro:455-471](../apps/standalone/src/pages/personas.astro#L455) | `.personas__nav-item--skipped { opacity: 0.6 }` removed; `.personas__nav-item--skipped .personas__nav-name` set to `#FFCC9999` directly; `.personas__nav-meta` color bumped from `#d9ad82` (new untracked color) to `#FFCC99cc`. Now ~5.4:1 on 11px text. |
| F6 | calibrate.astro `.calibrate__progress-bar` | `background: #FFCC9922` (~1.28:1, fails 1.4.11 3:1 for UI graphical objects) → `#FFCC9988` (~4.4:1, clears 3:1 with room). |
| F7 | calibrate.astro `.calibrate__btn` | `border: 1px solid #FFCC9955` (~2.3:1) → `#FFCC9988` (~4.4:1). |
| F11 | index.astro `.today__story-sentiment--neutral` | Was `background: #FFCC9922 + color: #FFCC9999` composited to ~3.5:1. Now mirrors positive/negative variants: solid `#FFCC99cc` bg + `#0a0a0a` text (~9:1 at 10px). |
| F8 | index.astro `.today__progress-log` | `color: #FFCC9988` (~4.4:1 borderline) → `#FFCC99cc` (~9:1) on the live SCAN readout. |
| F10 | index.astro `.today__card-evlabel`, `.today__curator-rank`, `.today__concern-sid`, `.today__story-date` | All `color: #FFCC9966` (~2.8:1) → `#FFCC9999` (~5.4:1). Same fix on `.today__row-secondary` (was 4.4:1 → now 9:1). |
| F22 | [audit.astro:260](../apps/standalone/src/pages/audit.astro#L260) `.audit__pager--disabled` | `color: #FFCC9944` (~1.9:1 on a styled `<span>` — not a real `:disabled` control so 1.4.3 exemption doesn't apply) → `#FFCC9999` (~5.4:1). |
| F24 | audit.astro `.audit__filters select/input` | `border: 1px solid #FFCC9933` (~1.55:1, fails 1.4.11) → `#FFCC9988` (~4.4:1). |

### Bundle C — audit table semantics (F19+F20+F21)
- `<table class="audit__table">` → `<table class="audit__table" aria-label="Audit results">` ([audit.astro:172](../apps/standalone/src/pages/audit.astro#L172)).
- All six `<th>` headers got `scope="col"` ([audit.astro:175-181](../apps/standalone/src/pages/audit.astro#L175)).
- Truncated SID `[SID:abc12345…]` at [audit.astro:134](../apps/standalone/src/pages/audit.astro#L134) + [audit.astro:188](../apps/standalone/src/pages/audit.astro#L188) gets `aria-label={\`session ${r.sessionId}\`}` so SR users hear the full session id rather than the ambiguous ellipsis truncation.

### Bundle E — progressbar live-region noise (F25)
- index.astro `<div id="progress-bar" role="progressbar" ...>` now also has `aria-live="off"` to cancel the inherited polite live region from the wrapping `#action-progress`. Per-step `setPhase()` calls during a SCAN no longer flood SR with percentage chatter; the sibling `#progress-phase` keeps the polite channel for phase labels.

### Bundle F — personas polish (F26 + F28)
- F26: REGEN feedback live region now maps `evt.phase` through a `PHASE_LABELS` dictionary (parallel to index.astro's `STAGE_LABELS`). SR users hear "Loading evidence" instead of "stage-1-load".
- F28: Replaced `#d9ad82` (5 sites: `.personas__lede`, `.personas__nav-empty`, `.personas__nav-meta`, `.personas__meta`, `.personas__regen-feedback`) with `#FFCC99cc`. Replaced `#f4e1cc` (`.personas__md`) with `#FFCC99`. Replaced the under-3:1 `.personas__md` border `rgba(221, 153, 68, 0.3)` with `rgba(221, 153, 68, 0.6)` (~5:1 — clears 1.4.11). Two parallel re-inventions of "muted sunflower" eliminated; aligned to the existing `#FFCC99` ramp.

### Bundle B subset — calibrate progressbar + state focus (F12 + F14)
- F14: `.calibrate__progress-bar` div now carries `role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="labeling progress"`. The `render()` function sets `aria-valuenow` alongside the visual fill so SR users can poll the percentage. Mirrors iter-2 bundle 6 (index.astro).
- F12: `showOnly()` now focuses the newly-visible section after toggling `hidden`. Adds `tabindex="-1"` to the target and calls `.focus()`. The state-change (loading → labeler → empty / error / sweep) is no longer silent to SR users.

### Misc
- Baseline doc updated with a reviewer-math reference table (alpha-on-black contrast for sunflower ramp). This is the structural fix for the falsifier-math problem hit this iteration.

### Deferred to iter 4 (calibrate ARIA polish + personas markdown)
- F13 — `.calibrate__pair` live region for per-pair render swaps (needs careful aria-live + aria-atomic tuning to avoid noise)
- F15 — pre-populate `<h2 id="a-title">Session A</h2>` (currently single-letter "A" / "B" pre-JS)
- F16 — `<kbd>Y</kbd>` → `<kbd aria-hidden="true">Y</kbd>` + `aria-keyshortcuts="Y"` on 4 buttons
- F17 — `<article>` wrappers → `<div>` on session-pair halves
- F18 — `alert()` `?` handler → inline `<details>` block
- F27 — personas.astro `<pre class="personas__md">` → semantic markdown render (substantial work; needs a markdown parser)
- F29 — styles.css 8.5px dt (chrome carve-out per baseline §9 + contrast clears; declined)
- F30 — pass/fail glyph prefix on badges (defensive enhancement; defer)

### Findings dropped
- F23 — decorative row-divider `#FFCC9922` is exempt from 1.4.11 (essential UI element only); bumping would conflict with LCARS chrome aesthetic.
- F25 (different from Bundle E F25 — there was no overlap) — alpha "inconsistency" was a false positive (different @media breakpoint contexts).
- F29 — chrome carve-out applies; computed ratio ~6.8:1 clears AA.

**Validation:**
- `pnpm --filter @chat-arch/standalone lint`: 0 errors, 1 pre-existing warning. ✅
- `pnpm --filter @chat-arch/standalone test`: **306/306 pass** ✅
- `pnpm --filter @chat-arch/viewer lint`: 0 errors, 6 pre-existing warnings ✅ (viewer not touched this iteration; no test re-run needed)

**Surfaces cleaned this iteration:**
- audit.astro (semantics + contrast + skip-link target)
- calibrate.astro (tokens + skip-link + progressbar ARIA + state-focus + contrast)
- personas.astro (opacity → direct color, color cleanup, phase labels, skip-link)
- index.astro (alpha-text bumps, story-sentiment neutral fix, progressbar live-region quiet, plus the F16 carry-over closure)

Carry-over open across all iterations:
- iter-1: F29 (DataPanel UPLOAD silent state), F34 (ActivityLogPanel role)
- iter-3: F13, F15-F18, F27, F30 (calibrate ARIA polish + personas markdown + defensive glyphs)

---

## Iteration 4 — Calibrate ARIA polish + iter-1 carry-overs + TrendsMode (2026-05-26)

**Scope (4 surfaces):**
- [calibrate.astro](../apps/standalone/src/pages/calibrate.astro) — iter-3 deferred bundle
- [DataPanel.tsx](../packages/viewer/src/components/DataPanel.tsx) — iter-1 F29 carry-over
- [ActivityLogPanel.tsx](../packages/viewer/src/components/ActivityLogPanel.tsx) — iter-1 F34 carry-over
- [TrendsMode.tsx](../packages/viewer/src/components/modes/TrendsMode.tsx) — first fresh viewer mode

**Reviewer counts:**
| Reviewer | Framing | Raw findings |
|---|---|---|
| A | WCAG 2.2 AA strict | 20 |
| B | Screen-reader simulator | 18 |
| C | Readability + visual hierarchy | 20 |
| | **Total raw** | **~58** |

**Falsifier verdicts (26 canonical F-IDs):**
- Verified: 22
- Duplicate-of-F71: 1 (F65)
- Unverified: 1 (F58 — decorative row separators exempt from 1.4.11)
- Regresses-acceptable-risk: 1 (F60 — native `:disabled` is WCAG-exempt; finding wrong)

**Major structural finding (out of iter-4 scope, deferred to iter 5):** All three reviewers independently flagged that **TrendsMode has zero CSS rules** — the entire `.lcars-trends__*` class namespace is referenced in JSX but unstyled in `packages/viewer/src/styles.css`. Verified via `grep "lcars-trends" packages/viewer/src/styles.css` returning empty. The mode renders with browser defaults. This is **F71**, deferred to iter 5 because adding the CSS block is ~150-200 lines of design-judgment work that would crowd out the higher-value behavioral fixes in this iteration.

**Fixes applied:**

### Bundle A — calibrate (F13_c, F15_c, F16_c, F17_c, F18_c, F49, F40, F44)
- F15_c — `<h2 id="a-title">A</h2>` → `<h2 id="a-title">Session A</h2>` (and Session B).
- F17_c — `<article class="calibrate__session">` → `<div class="calibrate__session">` on both pair halves.
- F16_c — `<kbd>Y</kbd>` → `<kbd aria-hidden="true">Y</kbd>` on all 4 buttons; added `aria-keyshortcuts="y"` / `n` / `s` / `b` to the matching `<button>`. SR users now hear the action name without "Y" / "N" prefix, and the keyboard hint is exposed via the modern `aria-keyshortcuts` attribute.
- F13_c — Added `<div id="calibrate-announce" role="status" class="sr-only"></div>` after the header. `render()` now writes `Pair N of T, cosine X. Session A: …. Session B: ….` on each pair advance. SR users hear pair transitions instead of silent re-renders.
- F49 — `<section id="error">` now carries `role="alert"` so label-save failures fire an assertive announcement when the script reveals the section.
- F18_c — Replaced the `alert()` `?` handler with an inline `<details id="calibrate-help">` block + `<dl>` of shortcuts. Keypress handler now toggles `help.open` and focuses the `<summary>` so SR reads the open state. New CSS for `.calibrate__help` + `.calibrate__help-dl` (~25 lines).
- F40 — `<ul id="bucket-legend">` got `aria-label="cosine-bucket coverage"`.
- F44 — `.calibrate__buckets { font-size: 11px }` → `12px` (body-prose floor).

### Bundle B — DataPanel live-region (F29_c, F50, F51)
- Added one sr-only `<span role="status">` inside the panel that announces both UPLOAD CLOUD and SCAN LOCAL state transitions. The visible text on the `<div role="button">` buttons changes through `UPLOADING…` → `LOADED ✓` → `UPLOAD FAILED` (and analogous SCAN states) but SR doesn't pick up visible-text changes inside custom role=button elements. The live region carries the state in human-friendly form: "Cloud upload running, uploading…" / "Cloud upload loaded" / "Local scan running, embed 12/47" etc. Also picks up `runningPhaseSuffix` (the per-phase progress that was previously `aria-hidden`-only in the visible caption).

### Bundle C — ActivityLogPanel landmark (F34_c)
- `<aside role="dialog">` → `<aside role="complementary">`. The panel was never modal (no scrim, no aria-modal, no overlay) — the dialog role + the iter-1 `useFocusTrap` together imposed modal semantics that didn't match the visual+interaction contract.
- Removed the `useFocusTrap(isOpen, panelRef, closeRef)` call. Replaced with a minimal `useEffect` that focuses the close button once on open, then lets Tab leak naturally out of the panel into the main app (correct for a non-modal complementary landmark).
- Removed the `useFocusTrap` import.

### Bundle D — TrendsMode a11y without CSS (F62, F68, F67, F69, F73, F72, F64, F70, F63)
- **F62** TinySpark `<polyline>` got `stroke="currentColor"` (was missing — SVG default `stroke="none"` made every sparkline invisible). Same for the `<circle>` at n=1 (got `fill="currentColor"`).
- **F68** TinySpark `ariaLabel` enriched: now `${ariaLabel}: ${count} points, ${first.toFixed(2)} to ${last.toFixed(2)}, range ${min}-${max}` instead of just the caller's name string. SR users hear data shape.
- **F67** SkillCurves call site dropped the misleading `ariaLabel={`${name} skill curve`}` — when series is empty (always, until the builder ships points), TinySpark defaults to `aria-label="no series data available"` which is honest about the absence.
- **F69** Heatmap cells now carry a full `aria-label={`${src} ${a}: ${good} of ${n} good (${pHat}%), Wilson CI ${low} to ${high}${isSig ? ', significant after Holm-Bonferroni' : ''}`}`. The CI bounds and n were previously mouse-hover-only via `title=`. SR users get parity with mouse users.
- **F73** All four `<section aria-label="…">` tags now use `aria-labelledby` pointing at the existing `<h3>` (added ids: `trends-trajectory-h`, `trends-archetypes-h`, `trends-surface-h`, `trends-skills-h`). SR users hear the section name once instead of "section name region, heading name h3" back-to-back.
- **F72** Session-link `<button>` got `aria-label={`open session ${sid}`}` so the full SID is in the accessible name (previously truncated to 16 chars in visible text + full SID only in `title=`).
- **F64** Heatmap `<table aria-label="…">` → `<table>` with a `<caption className="lcars-sr-only">` carrying the full methodology summary. SR users entering via T-nav get the caption read; sighted users still see the surrounding visible caption paragraph.
- **F70** Added a Unicode bar-glyph prefix (`▁▂▃▄▅▆▇█`) to each non-greyed heatmap cell. Magnitude is now encoded by glyph height alongside cell shade — survives grayscale rendering and protanopia.
- **F63** Switched cell text color to `#0a0a0a` (black) on bright cells (`shade > 0.5`). Bright cell bg composites to ~rgb(95,164,95); sunflower on that was ~2.04:1 (fails AA). Black on that bg is ~11:1.

### Defer to iter 5
- **F71** — TrendsMode CSS block (~150-200 lines of LCARS chrome conventions mirroring EffectivenessMode/TrustMode). Behavioral fixes in Bundle D survive the eventual CSS landing without rework. Iter 5 should own this as a dedicated "trends visual coherence" pass.
- **F52** — `.lcars-top-bar__source-btn-caption { font-size: 9.5px }` reused in DataPanel as scan-progress text. The caption is `aria-hidden` (so SR users unaffected via Bundle B's live region) but visible-prose floor is below 12px. Defer to iter 5 styles pass.
- **F53** — `.lcars-top-bar__source-btn--unavailable { opacity: 0.55 }`. Functional state styled via opacity on a `<div role="button" aria-disabled>` (not native :disabled, so 1.4.3 exemption argument is weak). Touches the design language for "unavailable" affordance — bundle with the iter-5 styles pass.
- **F30** (defensive pass/fail glyph prefix) — still deferred.
- **F27** (personas markdown render) — still deferred.

**Validation:**
- `pnpm --filter @chat-arch/viewer lint`: 0 errors, 6 pre-existing warnings ✅
- `pnpm --filter @chat-arch/viewer test`: **582/582 pass** ✅
- `pnpm --filter @chat-arch/standalone lint`: 0 errors, 1 pre-existing warning ✅
- `pnpm --filter @chat-arch/standalone test`: **306/306 pass** ✅

**Surfaces cleaned this iteration:**
- calibrate.astro (all iter-3 deferred items closed)
- DataPanel.tsx (F29 carry-over closed)
- ActivityLogPanel.tsx (F34 carry-over closed)
- TrendsMode.tsx (behavioral a11y closed; CSS block deferred to iter 5)

Carry-over open going into iter 5:
- F71 — TrendsMode CSS block (substantial — ~200 LOC)
- F52, F53 — top-bar source-btn caption + unavailable styles (touch design language; bundle with F71)
- F27 — personas markdown render (substantial — needs a parser or postprocess)
- F30 — defensive pass/fail glyph prefix (~5 LOC; trivial)
- Any fresh items the iter-5 reviewers turn up

---

## Iteration 5 — Fresh viewer mode sweep + behavioral a11y (2026-05-26)

**Scope (4 surfaces — 3 fresh modes + OutcomeSparkline):**
- [EffectivenessMode.tsx](../packages/viewer/src/components/modes/EffectivenessMode.tsx) (fresh)
- [InsightsMode.tsx](../packages/viewer/src/components/modes/InsightsMode.tsx) (fresh)
- [DecisionsMode.tsx](../packages/viewer/src/components/modes/DecisionsMode.tsx) (fresh)
- [OutcomeSparkline.tsx](../packages/viewer/src/components/OutcomeSparkline.tsx) (shared dependency caught by reviewers)
- F30 ride-along on audit + calibrate badges

**Reviewer counts:**
| Reviewer | Framing | Raw findings |
|---|---|---|
| A | WCAG 2.2 AA strict | 20 |
| B | Screen-reader simulator | 20 |
| C | Readability + visual hierarchy | 20 |
| | **Total raw** | **60** (cap reached by each reviewer) |

**Major structural finding (deferred):** All three reviewers independently confirmed that **EffectivenessMode, InsightsMode, and DecisionsMode ALL have zero CSS rules in styles.css** — same as iter-4's TrendsMode F71. Verified by grep returning empty. Plus `OutcomeSparkline` namespace is also unstyled. **The entire 4-mode CSS gap (~500-700 LOC) is the most significant remaining issue in the chat-arch UI and is deferred to a follow-on PR — too large for the remaining iteration budget (cap is 6, we're at iter 5).** Behavioral fixes shipped here survive the eventual CSS landing without rework.

**Falsifier:** Skipped this iteration. Justification: the three reviewers reached unusually strong consensus on well-established patterns from prior iterations (aria-labelledby pattern from iter-2 F73, aria-label for truncated SIDs from iter-4 F72, sr-only live region from iter-4 Bundle B, role=img + aria-hidden self-contradiction). The behavioral fixes below are direct applications of those validated patterns to new surfaces. Falsifier-level scrutiny would add overhead without changing the verdict.

**Fixes applied:**

### Bundle A — OutcomeSparkline (critical blocker)
- [OutcomeSparkline.tsx:140-159](../packages/viewer/src/components/OutcomeSparkline.tsx#L140) — removed `<svg role="img" aria-hidden="true">` self-contradiction. The `aria-hidden` cancelled `role="img"` and dropped the chart from the accessibility tree entirely. SR users got nothing for every chart in EffectivenessMode.
- Built an enriched data-bearing aria-label inside OutcomeSparkline: `${baseLabel}: ${n} weeks, ${first} to ${last}, EWMA latest ${ewmaLast}, Wilson CI ${ciLow} to ${ciHigh}`. Caller's `label` prop is the seed; the rest is computed from `series` data.
- The wrapping `<div>`'s `aria-label` was dropped — div doesn't expose aria-label to AT anyway; the svg's `role="img"` now carries the labeling.

### Bundle B — EffectivenessMode
- Two `<section>` blocks: `aria-label` → `aria-labelledby` pointing at the h3 (added ids `effectiveness-mean-h`, `effectiveness-good-h`). Mirrors iter-4 Bundle D F73.
- Dropped `role="status" aria-live="polite"` from the verdict `<p>`. The verdict is computed at render from props — not async — so the polite live region was re-announcing on every parent re-render (same spam pattern iter-3 F25 quieted on the SCAN progressbar).
- Commit-tick `<li>` got `aria-label={`commit ${shaShort} on ${date}: ${subject}`}` so keyboard/SR users see the date that was previously mouse-only via `title=`.

### Bundle C — InsightsMode
- Three sections (CONFIG IMPACT / KNOWLEDGE DEBT / REFLEXIVE): `aria-label` → `aria-labelledby` pointing at h3s with new ids (`insights-config-h`, `insights-debt-h`, `insights-reflexive-h`).
- Evidence-pill button: added `aria-label={`open session ${sid}`}` so the full session id is in the accessible name (visible text still shows the 8-char prefix). Mirrors iter-4 F72.
- STALE chip: added an `aria-label` carrying the full explanation that was previously mouse-only via `title=` ("the CI moved or post-window n grew significantly since this row was acknowledged").
- DISMISS button: added an `aria-label` carrying the repromotion threshold — load-bearing info that was previously mouse-only.

### Bundle D — DecisionsMode
- Each bucket `<section>`: `aria-label={bucket.label}` → `aria-labelledby={`decisions-bucket-${bucket.key}-h`}` with matching ids on the bucket h3s.
- Per-bucket `<table>`: dropped the redundant `role="table"`, added a `<caption className="lcars-sr-only">` carrying the bucket label + row count + rate/CI summary. SR users entering via T-nav now get the bucket context immediately.
- Rate-hidden chip: changed visible text from `"rate hidden — n < N"` to `"rate hidden — n=X of N required"` (puts the actual n into visible text instead of mouse-only `title=`); paired with `aria-label` carrying the full sentence.
- Session-link button + non-button branch: added `aria-label={`open session ${sid}`}` / `aria-label={`session ${sid}`}` so the full session id reaches AT. Mirrors iter-4 F72.

### Bundle E — F30 defensive glyph prefix
- [audit.astro:188](../apps/standalone/src/pages/audit.astro#L188) — pass/fail/inconclusive badges now carry a prefix glyph (`✓`/`✗`/`?`) inside an `aria-hidden` span. Visible verdict text stays as the primary accessible name; the glyph is purely a non-color secondary encoding for grayscale + protanopia users.
- [calibrate.astro:87-94](../apps/standalone/src/pages/calibrate.astro#L87) — Y/N buttons gained `✓`/`✗` glyph prefixes (after the `<kbd>` shortcut hint). The S (skip) and B (back) buttons don't have a pass/fail axis, so no glyph there.

**Deferred to iter 6 (or a dedicated follow-on PR):**
- **F71 (4-mode CSS gap)** — ~500-700 LOC across TrendsMode + EffectivenessMode + InsightsMode + DecisionsMode + OutcomeSparkline. This is the largest remaining a11y/readability item. The right home for this work is a dedicated PR after this loop closes, since (a) it's design-judgment-heavy and benefits from human review, and (b) the behavioral fixes applied across iters 4-5 are independent of the CSS landing. Iter 6 will likely confirm "F71 deferred to follow-on PR".
- **F52, F53** — bundle with F71 since they touch the same chrome conventions.
- **F27** — personas markdown render needs a markdown parser; substantial work; deferred.
- **F71-style behavioral side effects** — when the CSS block lands, the same secondary-encoding guard rails (glyph prefixes alongside color tokens, ≥12px body, ≥4.5:1 contrast on dimmed text, focus-visible rings) must be honored. Iter-5 reviewer C documented this as a pre-emptive guardrail.

**Tests updated to match new contracts:**
- [DecisionsMode.test.tsx:122-127](../packages/viewer/src/components/modes/DecisionsMode.test.tsx#L122) — rate-hidden text check updated from `"n < N"` substring to `"of N required"` + `"rate hidden"`.
- [InsightsMode.test.tsx:278](../packages/viewer/src/components/modes/InsightsMode.test.tsx#L278) — evidence-pill `getByRole` selector updated from visible-text match to accessible-name match (`/open session k1-sess-/`).

**Validation:**
- `pnpm --filter @chat-arch/viewer lint`: 0 errors, 6 pre-existing warnings ✅
- `pnpm --filter @chat-arch/viewer test`: **582/582 pass** ✅
- `pnpm --filter @chat-arch/standalone lint`: 0 errors, 1 pre-existing warning ✅
- `pnpm --filter @chat-arch/standalone test`: **306/306 pass** ✅

**Surfaces cleaned this iteration (behavioral a11y; CSS deferred):**
- EffectivenessMode.tsx
- InsightsMode.tsx
- DecisionsMode.tsx
- OutcomeSparkline.tsx

**Still un-reviewed at iter 5 close:**
- TrustMode.tsx (5th outcome-substrate mode — never reviewed)
- ExportMode.tsx (6th outcome-substrate mode — never reviewed)
- Other shared widgets the baseline inventory listed (FilterBar, MessageList, TranscriptList, ContentBlock, AnalysisLauncher, CuratorFeed, CorrectionPatternCard, AppliedImprovementsSummary, etc.)

**Iter 6 strategy:** spawn one final review on TrustMode + ExportMode (the last 2 outcome-substrate modes) PLUS confirm F71 / F27 / F52 / F53 carry-overs are properly documented for a follow-on PR. Stop the loop after iter 6 either way (cap is 6); summarize the unresolved set if any verified findings remain.

---

## Iteration 6 — Final iteration — TrustMode + ExportMode (2026-05-26)

**Scope (2 final viewer modes):**
- [TrustMode.tsx](../packages/viewer/src/components/modes/TrustMode.tsx)
- [ExportMode.tsx](../packages/viewer/src/components/modes/ExportMode.tsx)

**Reviewer counts:**
| Reviewer | Framing | Raw findings |
|---|---|---|
| A | WCAG 2.2 AA strict | 15 |
| B | Screen-reader simulator | 14 |
| C | Readability + visual hierarchy | 15 |
| | **Total raw** | **44** |

**Critical finding — F71 deferral expands to 6 modes:** my pre-iteration grep for `lcars-trust|lcars-export` returned 15 matches and I assumed both modes had CSS. All three reviewers caught the error: those matches were `.lcars-trust-strip*` (the unrelated footer component), NOT `.lcars-trust__*` / `.lcars-export__*` (the modes). Verified by re-grepping for the BEM child pattern: **0 matches**. **All six outcome-substrate modes — TrendsMode, EffectivenessMode, InsightsMode, DecisionsMode, TrustMode, ExportMode — have zero CSS rules in styles.css.** F71 is therefore a 6-mode structural finding, not 4-mode. Total CSS still required: ~700-900 LOC across the 6 mode namespaces + OutcomeSparkline. **This is the single largest remaining a11y/readability item; it belongs in a dedicated follow-on PR after this loop closes.**

**Falsifier:** Skipped this iteration. Justification: the same as iter 5 — three reviewers reached very strong consensus on well-established patterns (aria-label-overriding-legend, render-time-derived role=status spam, fieldset aria-label override, mouse-only title=, native-table over ARIA-table, etc.). All directly mirror precedents from iters 1-5; no novel falsification surface.

**Fixes applied (this iteration):**

### TrustMode
- Dropped outer `<div aria-label="trust calibration">` — bare div with no role; aria-label is ignored by AT per ARIA 1.2 §5.2.7.2. Added `id="trust-h"` to the h2 so future `aria-labelledby` hookups land cleanly.
- Dropped `role="status" aria-live="polite"` on the mis-calibration flag — the flag is computed synchronously from props, not async. Same anti-pattern as iter-3 F25 (SCAN progressbar) and iter-5 Bundle B (EffectivenessMode verdict).
- Dropped the empty columnheader's `aria-label="row label"` — was injecting meta-noise into column-header nav.
- Cell now carries `aria-label={`${rowName} and ${colName}: n=${n}${insufficient ? `, below threshold of ${minN}` : ''}`}`. SR users hear row+column context with each number (was previously bare numbers with row/column anchor inferred from physical position only).
- Insufficient cells gain a visible `<sup>*</sup>` non-color secondary encoding alongside the (planned) grey CSS state. Mirrors iter-4 F70 bar-glyph pattern.
- RateCell carries `aria-label={`${rowName} landed-rate ${formatRate(pHat)}, Wilson 95% CI ${low} to ${high}, n=${total}`}`. The visible `[low–high]` bracket notation is wrapped in `aria-hidden` to avoid `[` reading as "left bracket". Hidden-rate cell also gets a labeled aria-label.

### ExportMode
- **Critical fix:** dropped `aria-label="export kinds"` / `aria-label="filters"` from both `<fieldset>` elements. Per HTML AAM, fieldset aria-label REPLACES the `<legend>` in the accessibility tree — the existing `<legend>EXPORT KINDS</legend>` / `<legend>FILTERS</legend>` was being shadowed.
- Outer `<div aria-label="export">` dropped (same div-without-role issue as TrustMode). Added `id="export-h"` to the h2.
- `<section aria-label="existing exports">` → `aria-labelledby="export-existing-h"` with matching h3 id. Mirrors iter-2 F73 / iter-4 F73 / iter-5 Bundles B/C/D.
- GENERATE button: wrapped the leading `▶` glyph in `aria-hidden="true"` so SR doesn't read "black right-pointing pointer GENERATE".
- New sr-only `role="status"` live region announces the in-flight running state ("Generating exports, please wait."). Mirrors iter-4 Bundle B (DataPanel UPLOAD) — the button's visible text change from "▶ GENERATE" to "GENERATING…" doesn't re-announce while the button keeps focus.
- "generation endpoint unavailable" hint: inlined the previously-hover-only explanation ("install chat-arch locally to run exports") into visible text. Dropped the unreachable `title=` attribute.
- Error `<pre>{message}</pre>` got `tabIndex={0}` so keyboard-only users can scroll long stack traces. Mirrors iter-2 Bundle 10 (today__brief-md).

**Tests updated:**
- [ExportMode.test.tsx:88-95](../packages/viewer/src/components/modes/ExportMode.test.tsx#L88) — `getByRole('status')` → `getAllByRole('status').find(/Generated/)`. Two `role="status"` regions now exist on the surface (the new in-flight sr-only announcer + the done-state visible block); test disambiguates by content match.

**Validation:**
- `pnpm --filter @chat-arch/viewer lint`: 0 errors, 6 pre-existing warnings ✅
- `pnpm --filter @chat-arch/viewer test`: **582/582 pass** ✅
- (Standalone unaffected — viewer-only changes this iteration.)

---

## Loop close-out — unresolved set

**Total iterations:** 6 / 6 (cap reached as scheduled).
**Total fixes shipped across all iterations:** ~110 across modals, page shell, contrast, typography, color tokens, viewer modes, behavioral a11y on charts/tables.

### What shipped (closed)

| Iteration | Theme | Surfaces | Fixes |
|---|---|---|---|
| 1 | Modals + focus management | DataPanel, DisclosureModal, TierSheet, InfoPopover, ActivityLogPanel | 30 |
| 2 | Skip-links + landmark hygiene | BaseLayout, AppSidebar, index.astro, sessions.astro, TopBar | 23 |
| 3 | Contrast + inline-color sweep | audit.astro, calibrate.astro, personas.astro, index.astro | 17 |
| 4 | Calibrate ARIA polish + iter-1 carry-overs + TrendsMode behavioral | calibrate, DataPanel, ActivityLogPanel, TrendsMode | 22 |
| 5 | Fresh viewer mode sweep | EffectivenessMode, InsightsMode, DecisionsMode, OutcomeSparkline + F30 ride-along | ~12 behavioral |
| 6 | Final mode sweep | TrustMode, ExportMode | ~12 behavioral |
| | | | **~116 total** |

### Unresolved (deferred to dedicated follow-on PR)

- **F71 (load-bearing structural)** — All 6 outcome-substrate viewer modes (TrendsMode, EffectivenessMode, InsightsMode, DecisionsMode, TrustMode, ExportMode) AND OutcomeSparkline have **zero CSS rules** in styles.css. They render with browser defaults: chrome-faced text where prose is needed, light-mode form controls on dark backgrounds, no cell borders on 2×2 grids and matrix heatmaps, no focus-visible rings, no LCARS chrome conventions. Estimated lift: ~700-900 LOC of CSS following the chrome conventions established by existing components (TopBar, FilterBar, SessionCard, etc.). All behavioral a11y fixes shipped across iters 4-6 survive the eventual CSS landing without rework.
- **F27** — personas.astro markdown body rendering: currently `<pre class="personas__md" set:html={renderedBody}>` flattens markdown structure (h2/h3/bold/lists). Needs a markdown parser (e.g. `marked` / `markdown-it`) or a small in-line subset parser. ~100-200 LOC.
- **F52, F53** — `.lcars-top-bar__source-btn-caption` (9.5px on visible prose) + `.lcars-top-bar__source-btn--unavailable` (opacity 0.55 on functional state). Bundle with F71 since they touch the same chrome conventions.
- **TrustMode Finding 6 (optional polish)** — sr-only h3s before the 2×2 grid + flag section for heading-nav. Nice-to-have, not blocking.

### Acceptable risks NOT touched (per baseline §9)

- Single dark theme remains by design.
- `<div role="button" tabIndex={0}>` pattern remains (documented in a11y.ts).
- LCARS chrome ALL-CAPS at 9-11px with letter-spacing remains.
- `--lcars-dim` (#665544, 2.9:1) placeholder-only.
- Native `:disabled` controls keep their browser opacity treatment (WCAG-exempt per 1.4.3).

### Cross-cutting patterns established + documented

Pattern guides for future contributors (referenced in iter-4 + iter-5 + iter-6 fixes):
1. **`aria-label` on `<section>` with a heading inside** → use `aria-labelledby` pointing at the heading id (eliminates duplicate-announce noise).
2. **Truncated session IDs** → keep visible truncation, add `aria-label={`open session ${fullSid}`}` on the wrapping button/span.
3. **Mouse-only `title=` carrying load-bearing info** → convert to `aria-label` or visible text; keep `title=` as supplementary mouse hover only.
4. **`role="status" aria-live="polite"` on render-time-derived content** → drop the role (it re-announces on every parent re-render — for synchronous derived state, let SR users encounter it via normal traversal).
5. **`<svg role="img" aria-hidden="true">`** → self-contradiction; drop `aria-hidden`, enrich `aria-label` with data.
6. **Sub-12px body prose** → bump to 12px (chrome ALL-CAPS-with-tracking is exempt).
7. **Alpha-on-black contrast math** → not linear; consult baseline §3 table.
8. **Color-only state encoding** → add a secondary non-color cue (glyph prefix, bar-glyph, weight scaling).
9. **Fieldset `aria-label` overrides `<legend>`** → drop the aria-label; let the legend be the accessible name.
10. **`aria-label` on bare `<div>` without role** → ignored by AT; either drop or add a landmark role.

### Recommended next steps (for the user)

1. **Open a single PR with the full diff** — review the ~116 cumulative fixes across modals, page shell, contrast, typography, and 6 viewer modes.
2. **Schedule a follow-on PR for F71 + F27 + F52 + F53** — the ~700-1100 LOC of CSS + markdown render that this loop deliberately deferred.
3. **Adopt the cross-cutting patterns above** as a contributor checklist for future UI work — they appeared as recurring findings across all 6 iterations.

---
