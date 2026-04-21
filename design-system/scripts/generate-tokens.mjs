#!/usr/bin/env node
// Token generator for the Supergraphic Panel design system.
//
// Reads --lcars-* variables out of the canonical .lcars-root block in
// packages/viewer/src/styles.css, merges them with prescriptive scales
// authored here (radius, shadow, duration, font.size, font.weight,
// status aliases), and emits DTCG-formatted tokens to
// design-system/tokens.json.
//
// Drift guard: after emitting, scans design-system/spec.md for every
// hex literal (#rgb / #rrggbb / #rrggbbaa). Any hex present in spec.md
// that does NOT appear in the emitted tokens.json fails the script. This
// is the fence that keeps prose values aligned with source.
//
// Run from the repo root via `pnpm build` (or `node design-system/
// scripts/generate-tokens.mjs` directly).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stylesPath = resolve(repoRoot, 'packages/viewer/src/styles.css');
const tokensPath = resolve(repoRoot, 'design-system/tokens.json');
const specPath = resolve(repoRoot, 'design-system/spec.md');

const css = readFileSync(stylesPath, 'utf8');

// Grab the first .lcars-root { ... } block — the one that declares the
// tokens. Later .lcars-root rules layer on layout, not variables.
const rootBlockMatch = css.match(/\.lcars-root\s*\{([\s\S]*?)\n\}/);
if (!rootBlockMatch) {
  throw new Error('Could not find .lcars-root block in styles.css');
}
const rootBody = rootBlockMatch[1];

const varMatches = [...rootBody.matchAll(/--lcars-([\w-]+)\s*:\s*([^;]+);/g)];
const parsed = Object.fromEntries(
  varMatches.map(([, name, value]) => [name, value.trim()]),
);

function color(name, description) {
  const value = parsed[name];
  if (!value) throw new Error(`Expected --lcars-${name} in styles.css`);
  return { $value: value, $type: 'color', $description: description };
}

function font(name, description) {
  const value = parsed[`font-${name}`];
  if (!value) throw new Error(`Expected --lcars-font-${name} in styles.css`);
  const stack = value.split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, ''));
  return { $value: stack, $type: 'fontFamily', $description: description };
}

function alias(target, description) {
  return { $value: `{${target}}`, $type: 'color', $description: description };
}

function prescriptive(type, value, description) {
  return { $value: value, $type: type, $description: `Prescriptive: ${description}` };
}

const tokens = {
  $schema: 'https://www.designtokens.org/schemas/2025.10/format.json',
  $description:
    'Supergraphic Panel — the Chat Archaeologist visual design system. ' +
    'Source palette and font families are extracted from ' +
    'packages/viewer/src/styles.css. Scale tokens (radius, shadow, duration, ' +
    'font.size, font.weight, status aliases) are prescriptive additions ' +
    'authored for replicators; see design-system/spec.md for rationale.',
  color: {
    sunflower: color('sunflower', 'Primary text and titles. Never decorative.'),
    'sunflower-muted': color(
      'sunflower-muted',
      'Pre-composited sunflower × 0.85 over black. Solid background for inactive sidebar items so black text holds 10.25:1 WCAG AAA regardless of backdrop.',
    ),
    butterscotch: color(
      'butterscotch',
      'Chrome: top bar, sidebar elbows, ALL-CAPS labels, dividers. Never body text.',
    ),
    'butterscotch-muted': color(
      'butterscotch-muted',
      'Muted chrome for inactive mobile pill-bar items. Carries sunflower foreground at AA.',
    ),
    ice: color(
      'ice',
      'Data and code: model names, inline code, quantitative highlights. Decorative use forbidden.',
    ),
    violet: color(
      'violet',
      'Thinking / processing state: streaming indicators, semantic-analysis running, copy-to-MD action.',
    ),
    peach: color(
      'peach',
      'Cost and error accent: cost bars, error banners, CLI-Direct badge. Attention, not alarm.',
    ),
    bg: color('bg', 'Root frame background. Pure black.'),
    'bg-1': color('bg-1', 'Card and panel surface. One step above root.'),
    'bg-2': color('bg-2', 'Card hover surface. One step above bg-1.'),
    text: color('text', 'Alias for sunflower when used as a text color. Same value, semantic role differs.'),
    dim: color(
      'dim',
      'Reserved for inert placeholder glyphs (em-dashes, "—", missing values). Not for functional text — fails WCAG AA for body.',
    ),
    divider: color(
      'divider',
      'rgba(221, 153, 68, 0.18). Panel and card borders. Inherits from butterscotch at low alpha.',
    ),
  },
  font: {
    family: {
      chrome: font(
        'chrome',
        "ALL-CAPS labels, KPI values, titles, pills, top-bar. The voice of the chrome.",
      ),
      prose: font(
        'prose',
        'Body text inside cards and messages (≥12px paragraph text). IBM Plex Sans.',
      ),
      mono: font(
        'mono',
        'Model names, timestamps, code, keyboard hints, axis ticks. JetBrains Mono.',
      ),
    },
    weight: {
      regular: prescriptive('fontWeight', 400, 'Body prose only. Both IBM Plex Sans and JetBrains Mono ship a regular weight.'),
      medium: prescriptive('fontWeight', 500, 'Default chrome weight. Antonio at 500 is the reliable fallback when 600/700 feel heavy.'),
      semibold: prescriptive('fontWeight', 600, 'Emphasized prose and mono.'),
      bold: prescriptive('fontWeight', 700, 'Titles, pills, ALL-CAPS labels, KPI values. The chrome default for anything that should read as a label.'),
    },
    size: {
      '9': prescriptive('dimension', '9px', 'Row-label and legend caps. Floor for legible Antonio caps with 0.18em tracking.'),
      '10': prescriptive('dimension', '10px', 'Sidebar short badge, filter-row labels.'),
      '11': prescriptive('dimension', '11px', 'Chrome labels, pill text.'),
      '12': prescriptive('dimension', '12px', 'Body prose floor inside cards.'),
      '13': prescriptive('dimension', '13px', 'Info-popover body prose.'),
      '15': prescriptive('dimension', '15.5px', 'Session-card titles. Oddly specific on purpose — verified optically against the 2-line clamp at tier A.'),
      '18': prescriptive('dimension', '18px', 'Top-bar title at tier B+.'),
    },
  },
  radius: {
    sm: prescriptive('dimension', '6px', 'Card and panel corners at mobile tier.'),
    md: prescriptive('dimension', '8px', 'Card and panel corners at tablet / desktop.'),
    lg: prescriptive('dimension', '10px', 'Mid-bar and mode-area at desktop.'),
    pill: prescriptive('dimension', '14px', 'Source-pill, top-bar source-buttons (sized to half-height).'),
    'pill-lg': prescriptive('dimension', '20px', 'Narrow-banner, command-mode "more" button, search input at tier B+.'),
    elbow: prescriptive('dimension', '32px', 'Sidebar elbow at mobile. Asymmetric: `32px 0 0 0` or `0 0 0 32px` — never four-corner-equal.'),
    'elbow-lg': prescriptive('dimension', '40px', 'Sidebar elbow at desktop. Anchors the L-corner where vertical and horizontal arms meet.'),
  },
  shadow: {
    none: prescriptive('shadow', 'none', 'Default. The system does not use drop shadows for hierarchy — hierarchy comes from left-accent rules, border color, and surface stepping (bg → bg-1 → bg-2).'),
    panel: prescriptive(
      'shadow',
      { color: 'rgba(0, 0, 0, 0.6)', offsetX: '0px', offsetY: '10px', blur: '40px', spread: '0px' },
      'Reserved for floating panels that escape the frame (info-popover, rescan-banner, tier-sheet backdrop). Never on in-frame cards.',
    ),
    'ring-ice': prescriptive(
      'shadow',
      'inset 0 0 0 3px color-mix(in srgb, #99ccff 60%, transparent)',
      'Focus ring for quantitative / ice-accent contexts. Ring pulse, not glow.',
    ),
    'ring-violet': prescriptive(
      'shadow',
      'inset 0 0 0 3px color-mix(in srgb, #cc99cc 60%, transparent)',
      'Focus ring for thinking / violet-accent contexts.',
    ),
  },
  duration: {
    fast: prescriptive('duration', '80ms', 'Background color transitions on sidebar items, pill-bar pills.'),
    base: prescriptive('duration', '120ms', 'Default card hover transition (background, border, transform).'),
    slow: prescriptive('duration', '200ms', 'Analysis-launcher progress-fill width transition.'),
    boot: prescriptive('duration', '1400ms', 'Full boot cascade from top-bar through command-mode cards. Individual panel animations sit at 400–600ms with staggered delays.'),
    'pulse-focus': prescriptive('duration', '2200ms', 'Focus-pulse animations on filter-bar rows when navigated via analysis-tab cards.'),
  },
  status: {
    concept: alias('color.violet', 'Earliest / thinking state. Maps to violet. Prescriptive.'),
    active: alias('color.sunflower', 'In-progress / primary state. Maps to sunflower. Prescriptive.'),
    'open-pr': alias('color.ice', 'In review / quantitative active state. Maps to ice. Prescriptive.'),
    merged: alias('color.butterscotch', 'Completed / steady chrome state. Maps to butterscotch. Prescriptive.'),
    released: alias('color.peach', 'Shipped / notable accent. Maps to peach. Prescriptive.'),
  },
};

writeFileSync(tokensPath, JSON.stringify(tokens, null, 2) + '\n');

// --- Drift guard -----------------------------------------------------
// Scan spec.md for hex literals. Every hex in the spec must appear
// somewhere in the emitted tokens.json (on a base color token or
// in a prescriptive shadow definition). A mismatch means the prose
// drifted away from source — fail hard so CI catches it.

let driftErrors = [];
try {
  const spec = readFileSync(specPath, 'utf8');
  const tokensJson = JSON.stringify(tokens);
  const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;
  const specHexes = [...spec.matchAll(hexPattern)].map((m) => m[0].toLowerCase());
  const tokensLower = tokensJson.toLowerCase();
  const missing = [...new Set(specHexes)].filter((h) => !tokensLower.includes(h));
  if (missing.length > 0) {
    driftErrors.push(
      `spec.md cites hex value(s) not present in tokens.json: ${missing.join(', ')}. ` +
        `Either the prose drifted from source, or a new token is missing from the generator. ` +
        `Fix spec.md — styles.css is the source of truth for token values.`,
    );
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  // spec.md not yet written — skip drift guard on the first run.
}

if (driftErrors.length > 0) {
  console.error('\nToken drift detected:\n');
  for (const line of driftErrors) console.error(`  ${line}\n`);
  process.exit(1);
}

const parsedCount = Object.keys(parsed).length;
console.log(
  `design-system/tokens.json written (${parsedCount} --lcars-* vars extracted, ` +
    `plus prescriptive scales for radius, shadow, duration, font.size, font.weight, status).`,
);
