import type { APIRoute } from 'astro';
import { readFile, writeFile, mkdir, appendFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import type { Pattern } from '@chat-arch/schema';

/**
 * v2 spec §9 / decision D11: encode-as-pattern persistence.
 *
 *   - Always: append to `analysis/patterns.json` (machine-readable
 *     sidecar; future analysis input).
 *   - Optionally on user confirm: append a markdown block to the
 *     project's `CLAUDE.md` so the next Claude Code session in that
 *     project's repo sees it.
 *
 * Per spec §9: the sidecar path is the data-path canonical store,
 * the CLAUDE.md path is the human-facing surface. Either path
 * succeeding without the other is still a successful encode (so the
 * client surfaces partial success rather than "all-or-nothing").
 */
export const prerender = false;

const REQUIRED_HEADER = 'chat-arch-encode-pattern';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_PATTERN_BYTES = 64 * 1024;

function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

function csrfReject(reason: string): Response {
  return new Response(JSON.stringify({ ok: false, error: `Forbidden: ${reason}` }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

interface PatternsFile {
  generatedAt: number;
  patterns: Pattern[];
}

interface EncodePatternRequest {
  pattern?: Pattern;
  /** When set, also append a markdown block to `<projectPath>/CLAUDE.md`. */
  projectPath?: string;
  /** Pre-rendered markdown for the optional CLAUDE.md append (frontend-controlled). */
  claudeMdMarkdown?: string;
}

interface EncodePatternResponse {
  ok: boolean;
  sidecarPath: string;
  patternsCount: number;
  claudeMdAppended?: boolean;
  claudeMdPath?: string;
  errors: string[];
}

function isValidPattern(p: unknown): p is Pattern {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.body === 'string' &&
    typeof o.encodedAt === 'string'
  );
}

async function loadPatternsFile(path: string): Promise<PatternsFile> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as PatternsFile;
    if (!parsed || !Array.isArray(parsed.patterns)) {
      return { generatedAt: Date.now(), patterns: [] };
    }
    return parsed;
  } catch {
    return { generatedAt: Date.now(), patterns: [] };
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  let body: EncodePatternRequest;
  try {
    body = (await request.json()) as EncodePatternRequest;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!isValidPattern(body.pattern)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'pattern missing required fields' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
  if (Buffer.byteLength(JSON.stringify(body.pattern), 'utf8') > MAX_PATTERN_BYTES) {
    return new Response(JSON.stringify({ ok: false, error: 'pattern > 64 KiB' }), {
      status: 413,
      headers: { 'content-type': 'application/json' },
    });
  }

  const errors: string[] = [];

  // ---- Always: sidecar append ----
  const sidecarDir = join(repoRoot(), 'public', 'chat-arch-data', 'analysis');
  const sidecarPath = join(sidecarDir, 'patterns.json');
  let patternsCount = 0;
  try {
    await mkdir(sidecarDir, { recursive: true });
    const file = await loadPatternsFile(sidecarPath);
    // Replace any existing pattern with the same id to keep the
    // sidecar idempotent — re-encoding a pattern shouldn't fork it.
    const next = file.patterns.filter((p) => p.id !== body.pattern!.id);
    next.push(body.pattern);
    const out: PatternsFile = { generatedAt: Date.now(), patterns: next };
    await writeFile(sidecarPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    patternsCount = next.length;
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  // ---- Optional: project CLAUDE.md append ----
  let claudeMdAppended = false;
  let claudeMdPath: string | undefined;
  if (body.projectPath && body.claudeMdMarkdown) {
    const projectPath = body.projectPath.trim();
    if (!isAbsolute(projectPath)) {
      errors.push(`projectPath must be absolute (got ${projectPath})`);
    } else {
      try {
        const st = await stat(projectPath);
        if (!st.isDirectory()) {
          errors.push(`projectPath is not a directory: ${projectPath}`);
        } else {
          claudeMdPath = join(projectPath, 'CLAUDE.md');
          const block = `\n${body.claudeMdMarkdown.trim()}\n`;
          await appendFile(claudeMdPath, block, 'utf8');
          claudeMdAppended = true;
        }
      } catch (err) {
        errors.push(
          `CLAUDE.md append failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const payload: EncodePatternResponse = {
    ok: true,
    sidecarPath,
    patternsCount,
    ...(claudeMdAppended && claudeMdPath
      ? { claudeMdAppended: true, claudeMdPath }
      : claudeMdAppended
        ? { claudeMdAppended }
        : {}),
    errors,
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true, available: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
