# Supergraphic Panel

The canonical design system for the Chat Archaeologist viewer.

**Version:** 0.1.0 (initial release — 2026-04-21)

This folder is the **source**. Published surfaces
(https://chat-arch.dev/design-system/ and
https://raw.githubusercontent.com/BryceEWatson/chat-arch/main/design-system/)
are mirrors generated at build time. `packages/viewer/src/styles.css`
is the root source of truth for token values; `spec.md` is the
canonical prose; `tokens.json` is emitted by
`scripts/generate-tokens.mjs` on every `pnpm build` and fails CI if
prose in `spec.md` drifts from extracted token values.

Naming: the display form is **Supergraphic Panel** (two words,
title-cased). The slug form used in URLs, branch names, and any
future package scope is `supergraphic-panel`.

## Contents

- [`spec.md`](./spec.md) — the 2400-word prose spec. Read first.
- [`tokens.json`](./tokens.json) — DTCG-formatted
  ([schema](https://www.designtokens.org/schemas/2025.10/format.json))
  tokens. Generated. Do not edit by hand.
- [`scripts/generate-tokens.mjs`](./scripts/generate-tokens.mjs) —
  parses `--lcars-*` variables out of the viewer stylesheet, merges
  with prescriptive scales (radius, shadow, duration, font.size,
  font.weight, status aliases), emits `tokens.json`, and runs the
  drift guard against `spec.md`.

## Changelog

- **0.1.0** (2026-04-21) — Initial release. Palette, typography,
  component patterns, motion language, port recipes, attribution.

## For consumers

Point a language-model agent at
https://chat-arch.dev/design-system/spec.md and it has everything it
needs to apply the system to a blank project. For machine ingestion,
use `tokens.json` at https://chat-arch.dev/design-system/tokens.json.
Discovery index: https://chat-arch.dev/llms.txt.
