import type { APIRoute } from 'astro';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

/**
 * v2 spec §8 / decision D10: Persist a generated corrective prompt
 * to `_planning/prompts/{narrative-id}.md` AND signal the caller so
 * it can copy the same content to the clipboard.
 *
 * Both paths matter:
 *   - The on-disk file lets the user (or a future Claude Code session)
 *     re-find the prompt without having to keep the modal open.
 *   - The clipboard copy is the primary handoff per D10 — paste into
 *     a fresh Claude Code session.
 *
 * The endpoint refuses any narrative id that doesn't pass a strict
 * id-shape filter; the file is written under `_planning/prompts/` of
 * the chat-arch repo (resolved the same way as rescan.ts), so the
 * narrative id IS the filename and a hostile string would be a
 * straight path-traversal.
 */
export const prerender = false;

const REQUIRED_HEADER = 'chat-arch-save-prompt';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_BODY_BYTES = 1 * 1024 * 1024;
/**
 * Narrative ids are emitted by `discoverNarratives` as
 * `narr_<projectId>_<sentiment>` — kebab-cased ASCII. Locking the
 * filter to that shape stops `..` and Windows reserved characters
 * from sneaking in.
 */
const ID_SHAPE = /^[a-z0-9_-]{1,128}$/;

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

interface SavePromptRequest {
  narrativeId?: string;
  content?: string;
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  let body: SavePromptRequest;
  try {
    body = (await request.json()) as SavePromptRequest;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const id = (body.narrativeId ?? '').trim();
  const content = body.content ?? '';
  if (!ID_SHAPE.test(id)) {
    return new Response(
      JSON.stringify({ ok: false, error: `narrative id must match ${ID_SHAPE}` }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
  if (typeof content !== 'string' || content.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: 'empty content' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ ok: false, error: 'content > 1 MiB' }), {
      status: 413,
      headers: { 'content-type': 'application/json' },
    });
  }

  const dir = join(repoRoot(), '_planning', 'prompts');
  const outPath = join(dir, `${id}.md`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(outPath, content, 'utf8');
    const st = await stat(outPath);
    return new Response(
      JSON.stringify({ ok: true, path: outPath, bytes: st.size }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
};

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true, available: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
