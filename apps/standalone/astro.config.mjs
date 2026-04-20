import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import node from '@astrojs/node';

// `output: 'static'` with a Node adapter enables per-route opt-in to
// server rendering: every page stays static except routes that export
// `prerender = false`. Right now that's only `src/pages/api/rescan.ts`,
// which spawns the local exporter on POST to rescan disk + refresh the
// manifest. The rest (index.astro) builds to a static HTML file —
// deployments that want to drop the dynamic endpoint can remove the
// adapter and the route without touching the UI.
// COOP + COEP headers enable cross-origin isolation, which in turn
// enables SharedArrayBuffer. ONNX Runtime Web (via @huggingface/
// transformers) refuses to boot its WASM backend without SAB — even in
// single-threaded mode, because the distributed binary is the threaded
// variant. Without these headers the Phase-3 Analyze Topics action
// fails with an opaque heap-pointer error at ORT init.
//
// Safe here because the viewer doesn't embed third-party iframes,
// images, or scripts cross-origin. The only external resource is the
// HuggingFace CDN for model weights, fetched via the Cache API, which
// isn't subject to COEP (COEP governs embedded subresources, not
// programmatic fetch with default credentials).
//
// Static-host deployments (GitHub Pages, Netlify, Cloudflare Pages)
// need equivalent headers set at the hosting layer for the feature to
// work in production.
//
// `credentialless` instead of `require-corp` is deliberate: the CDN for
// MiniLM weights (huggingface.co) doesn't send CORP headers on its
// static assets, so `require-corp` would block the model download.
// `credentialless` still enables SharedArrayBuffer (and therefore
// ORT's WASM boot), but fetches cross-origin resources without
// credentials so the CORP check is skipped. Browser support: Chrome
// 96+, Safari 16.4+, Firefox 109+ — all well within our baseline.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  integrations: [react()],
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  vite: {
    server: {
      headers: crossOriginIsolationHeaders,
    },
    preview: {
      headers: crossOriginIsolationHeaders,
    },
  },
});
