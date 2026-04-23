/**
 * Local preview server for `dist/client/` that mirrors what Cloudflare
 * Pages does in production: serve the static build while applying the
 * COOP + COEP + XFO headers declared in `public/_headers`.
 *
 * Why this exists — `astro preview` with `@astrojs/node` serves static
 * files through the adapter's own Node server and does NOT read the
 * `_headers` file (that's a Pages-specific convention). Astro
 * middleware also skips prerendered routes at serve time, so it can't
 * inject the headers either. The result: the locally-previewed build
 * reports `crossOriginIsolated=false` and `SharedArrayBuffer=false`,
 * which means the Analyze Topics action fails at ORT init — even
 * though the production CF Pages build works fine.
 *
 * This tiny server closes that gap: it reads `_headers` from the dist
 * tree at boot and applies every directive to every response. That
 * keeps the local "what would the deployed site do" contract honest
 * without forcing the production routing through SSR just to unlock
 * middleware.
 *
 * Not a general-purpose static server — no range requests, no gzip
 * negotiation, no caching strategy beyond what's needed to make the
 * preview resemble CF Pages. Replace with `wrangler pages dev` if
 * fidelity matters more than the zero-install story.
 */
import http from 'node:http';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.PORT ?? '4325', 10);
const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', 'dist', 'client');

// Minimal MIME map — covers every file type the Astro client bundle
// actually emits. Anything else falls through to `application/
// octet-stream`, which is correct for unknown blobs.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Parse `_headers` (CF Pages format) into a list of { pattern, headers }
 * rules. Format:
 *
 *   /path/*
 *     Header-Name: value
 *     Another-Header: value
 *
 * We support `*` wildcard only (no named captures), which matches the
 * file we ship. Indented lines attach to the most recent pattern.
 */
function parseHeaders(path) {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const rules = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, ''); // strip comments
    if (!line.trim()) continue;
    const isIndented = /^\s+/.test(rawLine);
    if (!isIndented) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
    } else if (current) {
      const m = line.trim().match(/^([^:]+):\s*(.*)$/);
      if (m) current.headers[m[1].trim()] = m[2].trim();
    }
  }
  return rules;
}

function patternMatches(pattern, path) {
  if (pattern === '/*') return true;
  // Only `*` is supported — turn it into a regex-safe glob.
  const regex = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  );
  return regex.test(path);
}

const headerRules = parseHeaders(join(ROOT, '_headers'));

function applyHeaders(res, urlPath) {
  for (const rule of headerRules) {
    if (patternMatches(rule.pattern, urlPath)) {
      for (const [name, value] of Object.entries(rule.headers)) {
        res.setHeader(name, value);
      }
    }
  }
}

function resolveFile(urlPath) {
  // Security: reject path traversal. `normalize` collapses `..`
  // segments; `startsWith` confirms the resolved path stays inside
  // ROOT even if the attacker crafted a URL that walks out.
  const rel = normalize(urlPath).replace(/^[/\\]+/, '');
  const full = resolve(ROOT, rel);
  if (!full.startsWith(ROOT)) return null;
  try {
    const s = statSync(full);
    if (s.isDirectory()) {
      const indexPath = join(full, 'index.html');
      statSync(indexPath);
      return indexPath;
    }
    return full;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const urlPath = decodeURIComponent(url.pathname);

  applyHeaders(res, urlPath);

  const filePath = resolveFile(urlPath);
  if (!filePath) {
    // 404 — mirrors how CF Pages responds to missing assets. No SPA
    // fallback; the viewer is a single HTML file and the dev-only
    // API routes (/api/rescan, /api/clear) don't exist in the
    // static client build by design.
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not Found');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  const gotCoop = headerRules.some((r) =>
    Object.keys(r.headers).some((k) => k.toLowerCase() === 'cross-origin-opener-policy'),
  );
  // eslint-disable-next-line no-console
  console.log(
    `preview-with-headers: http://localhost:${PORT}/ · ${headerRules.length} _headers rules · COOP ${gotCoop ? 'present' : 'MISSING'}`,
  );
});
