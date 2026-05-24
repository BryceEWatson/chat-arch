import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/schema',
  'packages/analysis',
  'packages/exporter',
  'packages/viewer',
  'packages/mcp-server',
  'apps/standalone',
]);
