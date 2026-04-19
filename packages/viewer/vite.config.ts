import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Dev harness for the viewer. Not used for production builds — the viewer
 * is consumed as a TypeScript source package and compiled by its consumer
 * (apps/standalone). Run with `pnpm --filter @chat-arch/viewer dev`.
 *
 * The vite server serves `demo/index.html` as the app entry and exposes the
 * fixture tree at `/chat-arch-data/...` so the viewer (which defaults to
 * `/chat-arch-data/manifest.json`) works without configuration.
 */
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  server: {
    port: 5178,
    strictPort: true,
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url))],
    },
  },
  resolve: {
    alias: {
      '@chat-arch/viewer': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  publicDir: fileURLToPath(new URL('./demo/public', import.meta.url)),
});
