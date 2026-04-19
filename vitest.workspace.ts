import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/schema',
  'packages/exporter',
  'packages/viewer',
  // apps/standalone intentionally not in vitest workspace — Astro tests later
]);
