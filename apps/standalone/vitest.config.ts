import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the standalone Astro app. Scoped to `test/`
 * because the API endpoints under `src/pages/api/` import Astro
 * types — we test them by importing only the pure helpers each
 * exports (CSRF predicates, path checks, ranking math), not the
 * `POST` handlers themselves.
 */
export default defineConfig({
  test: {
    name: '@chat-arch/standalone',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
