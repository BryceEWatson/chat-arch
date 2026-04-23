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
  // Public URL of the hosted deploy. Used for sitemap generation and
  // any canonical-URL emission. The custom domain resolves via
  // Cloudflare Pages (DNS CNAME → chat-arch.pages.dev); the Pages
  // default `.pages.dev` subdomain continues to serve the same build.
  site: 'https://chat-arch.dev',
  integrations: [react()],
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  // Astro 5.9+ ships an auto-hashing CSP. It computes a SHA-256 hash
  // for every inline <script> and <style> block it emits (including
  // the astro-island loader + hydration bootstrap) and injects those
  // hashes into script-src / style-src — so inline scripts we ship
  // are permitted while anything injected at runtime (e.g. from
  // transcript content that bypassed the viewer's sanitizer) still
  // gets blocked.
  //
  // Replaces the hand-written <meta http-equiv="Content-Security-
  // Policy"> that used to live in BaseLayout.astro. That pinned
  // script-src to 'self' with no inline allowance, which blocked the
  // island loader and stranded every page on "LOADING MANIFEST…"
  // because hydration never started.
  //
  // `resources` *replaces* Astro's default resources for each
  // directive (it does not merge), so anything we want permitted has
  // to be listed explicitly alongside the auto-generated hashes.
  // style-src keeps 'unsafe-inline' because React components can
  // inject runtime <style> tags that Astro doesn't see at build
  // time (no hash generated); scripts have no equivalent runtime
  // injection path, so script-src stays tight.
  experimental: {
    csp: {
      directives: [
        "default-src 'self'",
        // Fonts are self-hosted via @fontsource (see BaseLayout.astro).
        // Google Fonts hosts used to be allowlisted here; removed once
        // the app stopped fetching from fonts.gstatic.com so an
        // accidental future regression (e.g. a copy-pasted <link>) can
        // be caught by CSP instead of silently leaking IPs.
        "font-src 'self'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ],
      scriptDirective: {
        resources: ["'self'"],
      },
      styleDirective: {
        // Mirror the font-src tightening: no remote stylesheet origin
        // is needed now that @fontsource ships the @font-face rules
        // bundled with the rest of our CSS.
        resources: ["'self'", "'unsafe-inline'"],
      },
    },
  },
  vite: {
    server: {
      headers: crossOriginIsolationHeaders,
    },
    preview: {
      headers: crossOriginIsolationHeaders,
    },
  },
});
