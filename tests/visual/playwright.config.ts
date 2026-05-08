import { defineConfig, devices } from '@playwright/test';

/**
 * v2 spec §11 / decision D15: Playwright suite for visual / structural
 * regression coverage of the four surfaces × three viewport tiers.
 * Asserts on DOM shape + class names + accent counts rather than
 * comparing screenshots — image-diff suites are notoriously fragile
 * across OS / GPU / font-render combinations, and the chrome already
 * has a strict design-token contract for visuals.
 *
 * Local invocation:
 *   pnpm --filter @chat-arch/standalone dev   # in one terminal
 *   pnpm test:visual                          # in another (uses webServer below)
 *
 * CI invocation: gated on the `needs-visual-tests` PR label by
 * `.github/workflows/visual-tests.yml`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.CHAT_ARCH_BASE_URL ?? 'http://localhost:4321',
    trace: 'retain-on-failure',
    headless: true,
  },
  // All three projects run on Chromium with viewport overrides — using
  // Apple-device presets pulls in the WebKit browser, which (a) needs
  // a separate `playwright install webkit` step and (b) doesn't add
  // signal: the surfaces being asserted are layout-driven by viewport
  // width, not engine quirks. Keeping a single browser keeps the
  // install graph + CI matrix lean per D15.
  projects: [
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 800 } },
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 900 } },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  // The webServer block lets `pnpm test:visual` boot Astro automatically
  // when no dev server is already running. Skipped when a CHAT_ARCH_BASE_URL
  // env var explicitly targets an existing instance (e.g., a CI runner
  // that already started the preview build).
  ...(process.env.CHAT_ARCH_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter @chat-arch/standalone dev --host 127.0.0.1',
          url: 'http://127.0.0.1:4321',
          reuseExistingServer: true,
          timeout: 60_000,
        },
      }),
});
