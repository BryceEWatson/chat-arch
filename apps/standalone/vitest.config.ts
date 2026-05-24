import { getViteConfig } from 'astro/config';

/**
 * Vitest config for the standalone Astro app. Uses `getViteConfig`
 * so Astro components (`*.astro`) can be imported and rendered via
 * `experimental_AstroContainer` in component tests. The API endpoint
 * tests under `test/api/` import only pure helpers and are unaffected
 * by the Astro pipeline.
 */
export default getViteConfig({
  test: {
    name: '@chat-arch/standalone',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
