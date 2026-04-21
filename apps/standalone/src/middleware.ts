import { defineMiddleware } from 'astro:middleware';

/**
 * Adds `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-
 * Embedder-Policy: credentialless` to every response.
 *
 * Why: the Phase-3 Analyze Topics action loads ONNX Runtime Web in a
 * Worker via @huggingface/transformers. ORT refuses to boot its WASM
 * backend unless `crossOriginIsolated === true`, which requires COOP
 * + COEP to be served by the host. The `vite.server.headers` option
 * in `astro.config.mjs` is documented to do this but the Astro dev
 * middleware swallows it in the current release; this Astro
 * middleware hook is the officially-supported workaround and also
 * covers the production Node adapter path.
 *
 * `credentialless` (vs. `require-corp`) is deliberate — the MiniLM
 * weights live on huggingface.co which doesn't send CORP headers on
 * static assets, so `require-corp` would block the model download.
 * `credentialless` still enables SharedArrayBuffer, just fetches
 * cross-origin resources without credentials to bypass the CORP
 * check. Chrome 96+, Safari 16.4+, Firefox 109+.
 *
 * Safe here because the viewer doesn't embed any cross-origin
 * iframes / images / scripts that would care about credentials
 * being stripped. The only cross-origin traffic is the HF CDN for
 * model weights, which is public-read and doesn't need credentials.
 */
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  // Clone the response headers since Response objects returned by
  // Astro's static handler can be frozen; work on a mutable copy.
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return response;
});
