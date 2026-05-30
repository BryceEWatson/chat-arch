/**
 * Selectors — the single home for `data → view-model` derivations.
 *
 * Per the "Centralize data processing" plan: every transform whose input
 * is schema- or analysis-typed lives here (NOT inline in a viewer
 * component). Selectors are pure, deterministic, and React-free; any
 * notion of "now" is a parameter, never `Date.now()`. They call the
 * existing stats kernels (`wilsonCI`, `ewma`, …) — never reimplement a
 * stat. View-model types are exported alongside their selector so
 * components stop declaring `KindGroup` / `TrustTally` / `TopItem`
 * locally.
 *
 * Naming convention:
 *   - `group*` / `build*` → returns a structured value
 *   - `rank*` / `sort*`   → returns an ordered value
 *   - `count*`            → returns a scalar
 *   - `is*` / `*Fired`    → returns a boolean
 *
 * Client-state-coupled selectors (localStorage cursors, `insightsAcks`,
 * uploaded-ZIP merge) do NOT belong here — they live in
 * `packages/viewer/src/selectors/` and compose an analysis selector with
 * client state. See the plan's "Escape hatch" section.
 *
 * This barrel is populated phase by phase. Phase 0 ships it empty (no
 * behavior change); Phase 1 onward fills it.
 */

export * from './trust.js';
export * from './decisions.js';
export * from './actionItems.js';
