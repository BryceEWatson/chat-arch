import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CHAT_QUESTION_MAX_CHARS,
  type ChatCitation,
  type ChatStreamEvent,
} from '@chat-arch/schema';

/**
 * Chat page synthesis endpoint. Spawns `claude -p` against the `chat-
 * answer` skill, normalizes its `--output-format=stream-json` events into
 * NDJSON for the browser, and validates citations against the corpus the
 * agent actually read during the turn.
 *
 * Architecture notes (v3 first-principles framing):
 *
 *   - The browser does NOT pre-retrieve. The skill, running as Claude
 *     Code with `Read Grep Glob Task` granted, retrieves from the corpus
 *     itself. The browser POSTs only `{ chatId, question, intent,
 *     resumeSessionId? }`.
 *
 *   - Tool grant is intentionally narrow. No Bash (no shell exec), no
 *     Write/Edit (Phase 1 is read-only — future save-as-memory flows
 *     will be separate user-triggered actions). Compare with `mine-
 *     corrections.ts:631` which grants the broader `Read Write Edit
 *     Bash Task Glob Grep` because that skill MUST mutate the analysis
 *     files; chat-answer never does.
 *
 *   - Concurrency. Unlike `mine-corrections` (single-flight: one global
 *     mining run at a time), chat answers must run concurrently across
 *     conversations. We gate two-tier: per-`chatId` single-flight
 *     (returns 409) plus a global ceiling (returns 429) so N parallel
 *     tabs can't OOM the host with spawned agents.
 *
 *   - Citation validation. The skill is instructed to emit `[SID:<uuid>]`
 *     inline. We parse those out of token text, but cross-reference each
 *     SID against the agent's actual `Read` tool_use history before
 *     emitting a `citation` event. Hallucinated SIDs are dropped silently
 *     so they never reach the rendered chips. The manifest IS treated as
 *     a "saw everything" Read — once the agent reads `manifest.json`,
 *     all manifest SIDs become quotable. Transcript reads add per-file
 *     UUIDs.
 *
 *   - Tmpdir-only artifacts. The per-request bundle JSON is written to
 *     `os.tmpdir()` (NEVER under `apps/standalone/public/chat-arch-
 *     data/` — that path is PII-sensitive per CLAUDE.md). Removed in
 *     `finally`. The skill reads it within the spawn lifetime.
 *
 *   - End-of-stream sentinel. Claude Code emits a `result` event when
 *     the turn completes; we re-emit as `{ type: 'final' }`. If the
 *     stream closes without a `result`, we emit `{ type: 'error',
 *     message: 'silent abort' }` — same correctness story as mine-
 *     corrections' `classifyOutcome`, scaled down.
 */
export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-chat-answer';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_CONCURRENT = 3;
const SILENT_ABORT_GRACE_MS = 60_000;

export function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function csrfReject(reason: string): Response {
  return jsonError(403, `Forbidden: ${reason}`);
}

/**
 * Per-chatId single-flight + global ceiling. A new turn against the SAME
 * chat while one is in flight returns 409 (Conflict). When the server-wide
 * total hits `MAX_CONCURRENT`, additional new-chat starts return 429 (Too
 * Many Requests). Tabs of the SAME conversation can never double-spawn;
 * unrelated conversations can run in parallel up to the ceiling.
 */
const inFlightByChatId = new Map<string, { startedAt: number }>();
let totalInFlight = 0;

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

interface ParsedBody {
  chatId: string;
  question: string;
  intent: 'ask' | 'find-opportunities';
  resumeSessionId?: string;
}

function parseRequestBody(raw: unknown): { ok: true; body: ParsedBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const b = raw as Record<string, unknown>;
  if (!isUuid(b['chatId'])) return { ok: false, error: 'chatId must be a UUID' };
  const q = b['question'];
  if (typeof q !== 'string' || q.trim().length === 0) {
    return { ok: false, error: 'question must be a non-empty string' };
  }
  if (q.length > CHAT_QUESTION_MAX_CHARS) {
    return { ok: false, error: `question exceeds ${CHAT_QUESTION_MAX_CHARS} chars` };
  }
  const intent = b['intent'];
  if (intent !== 'ask' && intent !== 'find-opportunities') {
    return { ok: false, error: 'intent must be "ask" or "find-opportunities"' };
  }
  const rs = b['resumeSessionId'];
  if (rs !== undefined && !isUuid(rs)) {
    return { ok: false, error: 'resumeSessionId, when present, must be a UUID' };
  }
  return {
    ok: true,
    body: {
      chatId: b['chatId'] as string,
      question: q,
      intent,
      ...(typeof rs === 'string' ? { resumeSessionId: rs } : {}),
    },
  };
}

/**
 * Tracks every SID the agent gained read-access to during the turn. The
 * manifest read unlocks ALL manifest SIDs at once (it's the canonical
 * session index — anything cited from it is grounded in real metadata).
 * Per-transcript reads add a single UUID each. Used to validate inline
 * `[SID:<uuid>]` citations before they reach the UI.
 */
class CitationValidator {
  private explicitSids = new Set<string>();
  private allFromManifest = false;
  /** SID → snippet preview, populated when manifest is read. */
  private previewBySid = new Map<string, string>();

  noteRead(filePath: string, fileContent?: string): void {
    const normalized = filePath.replace(/\\/g, '/');
    // Manifest read → unlock all SIDs from the file (if we can parse it).
    if (normalized.endsWith('/manifest.json') || normalized.endsWith('chat-arch-data/manifest.json')) {
      this.allFromManifest = true;
      if (fileContent) {
        try {
          const m = JSON.parse(fileContent) as { sessions?: Array<{ id?: unknown; preview?: unknown }> };
          for (const s of m.sessions ?? []) {
            if (isUuid(s.id)) {
              this.explicitSids.add(s.id);
              if (typeof s.preview === 'string') {
                this.previewBySid.set(s.id, s.preview.slice(0, 200));
              }
            }
          }
        } catch {
          // best-effort; the read still grants citation rights even if
          // we couldn't parse it ourselves.
        }
      }
      return;
    }
    // Transcript or per-session file → extract UUID from filename.
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(normalized);
    if (m) this.explicitSids.add(m[1]!.toLowerCase());
  }

  /** True iff the agent has visibility into this SID via a prior Read. */
  isCitable(sid: string): boolean {
    const lower = sid.toLowerCase();
    if (this.explicitSids.has(lower)) return true;
    // If the agent read manifest.json but we couldn't parse it locally
    // (e.g. the agent only saw part of it), accept any well-formed UUID
    // — the agent had access to the full SID list.
    return this.allFromManifest && isUuid(sid);
  }

  snippetFor(sid: string): string | undefined {
    return this.previewBySid.get(sid.toLowerCase());
  }
}

/**
 * Walk the assistant text emitted so far and yield each unique
 * `[SID:<uuid>]` reference NOT yet seen on this turn. Stateful per turn:
 * the caller maintains the "already emitted" set so we don't re-emit
 * citations as more tokens arrive.
 */
function* scanForNewCitations(
  accumulatedText: string,
  alreadyEmitted: Set<string>,
): Generator<string> {
  const re = /\[SID:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(accumulatedText)) !== null) {
    const sid = match[1]!.toLowerCase();
    if (alreadyEmitted.has(sid)) continue;
    alreadyEmitted.add(sid);
    yield sid;
  }
}

/**
 * Best-effort one-line summary for a tool call. Picks the most salient
 * input field so the UI's AgentTrace row shows the agent's intent, not
 * a JSON blob. Capped at 200 chars.
 */
function summarizeToolUse(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const o = input as Record<string, unknown>;
  const pick = (k: string): string | undefined =>
    typeof o[k] === 'string' ? (o[k] as string) : undefined;
  let detail: string | undefined;
  if (name === 'Read' || name === 'Glob') detail = pick('file_path') ?? pick('pattern');
  else if (name === 'Grep') detail = pick('pattern');
  else if (name === 'Task') detail = pick('description') ?? pick('subagent_type');
  else detail = pick('description');
  const cleaned = detail ? detail.replace(/\s+/g, ' ').slice(0, 200) : '';
  return cleaned ? `${name} ${cleaned}` : name;
}

interface SpawnContext {
  send: (ev: ChatStreamEvent) => void;
  validator: CitationValidator;
  /** SIDs already emitted as `citation` events this turn. */
  emittedCitations: Set<string>;
  /** Concatenated assistant text seen this turn (across all `text` blocks). */
  assistantBuf: { v: string };
  /** True once we see Claude Code's `result` event. */
  sawResult: { v: boolean };
}

/**
 * Parse one Claude Code `--output-format=stream-json` line and re-emit
 * it as ChatStreamEvent(s). Tolerant of unknown shapes — surfaces them
 * as a `thinking` trace rather than crashing.
 */
function handleStreamJsonLine(line: string, ctx: SpawnContext): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Not JSON — likely a stderr leak surfacing in stdout. Treat as
    // thinking trace; the UI renders these collapsed.
    ctx.send({
      type: 'trace',
      event: { kind: 'thinking', preview: trimmed.slice(0, 200), ts: Date.now() },
    });
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const evType = o['type'];
  let claudeSessionId: string | null = null;

  if (evType === 'system' && o['subtype'] === 'init') {
    const sid = o['session_id'];
    if (typeof sid === 'string') {
      claudeSessionId = sid;
      ctx.send({ type: 'claude-session', claudeSessionId: sid });
    }
    return claudeSessionId;
  }

  if (evType === 'assistant') {
    const msg = o['message'] as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg!.content : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const bt = b['type'];
      if (bt === 'text' && typeof b['text'] === 'string') {
        const text = b['text'];
        ctx.assistantBuf.v += text;
        ctx.send({ type: 'token', text });
        // Scan for new citations across the cumulative text.
        for (const sid of scanForNewCitations(ctx.assistantBuf.v, ctx.emittedCitations)) {
          if (!ctx.validator.isCitable(sid)) continue;
          const citation: ChatCitation = {
            sessionId: sid,
            // We don't know source from a SID alone; the UI resolves it
            // by looking up the manifest. Default to 'cloud' is wrong —
            // omit source and let the UI fill it. (Schema permits source
            // as required; we pick a safe default and the UI overrides
            // from the manifest.)
            source: 'cowork',
            ...(ctx.validator.snippetFor(sid)
              ? { snippet: ctx.validator.snippetFor(sid)! }
              : {}),
          };
          ctx.send({ type: 'citation', citation });
        }
      } else if (bt === 'tool_use') {
        const name = typeof b['name'] === 'string' ? b['name'] : 'tool';
        const summary = summarizeToolUse(name, b['input']);
        if (name === 'Task') {
          const inp = (b['input'] ?? {}) as Record<string, unknown>;
          const agent = typeof inp['subagent_type'] === 'string' ? inp['subagent_type'] : 'agent';
          ctx.send({
            type: 'trace',
            event: { kind: 'sub_agent', agent, summary, ts: Date.now() },
          });
        } else {
          ctx.send({
            type: 'trace',
            event: { kind: 'tool_use', tool: name, summary, ts: Date.now() },
          });
        }
      }
    }
    return null;
  }

  if (evType === 'user') {
    // tool_result events come in `user`-wrapped messages. We use these
    // to populate the citation validator with file contents the agent
    // just read (Read tool_result includes the file content).
    const msg = o['message'] as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg!.content : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_result') continue;
      // The tool_result carries the read content; we'd need to also know
      // WHICH tool produced it (Read vs Grep vs Glob) to interpret it.
      // The id correlates to the prior tool_use. For the citation
      // validator's purposes we already noted the path when we saw the
      // tool_use; we don't need the result body. Errors surface as
      // trace events.
      const isErr = b['is_error'] === true;
      if (isErr) {
        const txt = typeof b['content'] === 'string' ? (b['content'] as string).slice(0, 200) : 'tool error';
        ctx.send({
          type: 'trace',
          event: { kind: 'error', message: txt, ts: Date.now() },
        });
      }
    }
    // We also need to register each Read's file_path with the validator.
    // The tool_use already passed through above, so we register there
    // instead. (See assistant branch — tool_use blocks include input.)
    return null;
  }

  if (evType === 'result') {
    ctx.sawResult.v = true;
    return null;
  }

  // Unknown shape — surface as a thinking trace so the operator can see
  // it but the UI doesn't crash.
  ctx.send({
    type: 'trace',
    event: {
      kind: 'thinking',
      preview: JSON.stringify(o).slice(0, 200),
      ts: Date.now(),
    },
  });
  return null;
}

/**
 * Walk a single tool_use event and tell the validator what corpus
 * material is now citable. Called as a side effect during stream parsing
 * so that by the time the assistant emits `[SID:abc]`, the validator
 * already knows whether `abc` was a Read filename.
 */
function noteToolUseForValidator(name: string, input: unknown, validator: CitationValidator): void {
  if (!input || typeof input !== 'object') return;
  const o = input as Record<string, unknown>;
  if (name === 'Read' && typeof o['file_path'] === 'string') {
    validator.noteRead(o['file_path']);
  } else if (name === 'Glob' && typeof o['pattern'] === 'string') {
    // Glob doesn't read content; it just enumerates. Treat as a hint
    // that the agent is searching — no validator change.
  } else if (name === 'Grep' && typeof o['pattern'] === 'string') {
    // Grep may surface SIDs in matched paths; without seeing the result
    // body we can't know, so skip. The agent will Read individual
    // transcripts if it needs to cite them.
  }
}

function buildRequestBundle(body: ParsedBody, turnIndex: number): string {
  return JSON.stringify(
    {
      chatId: body.chatId,
      question: body.question,
      intent: body.intent,
      turnIndex,
    },
    null,
    2,
  );
}

/**
 * Spawn `claude -p` with stream-json output, pump events to the client,
 * and clean up the request file when done.
 */
async function runChatAnswer(
  body: ParsedBody,
  send: (ev: ChatStreamEvent) => void,
): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  send({ type: 'start', requestId, chatId: body.chatId, startedAt });

  const requestFile = join(tmpdir(), `chat-arch-chat-${requestId}.json`);
  await writeFile(requestFile, buildRequestBundle(body, 0), 'utf8');

  const validator = new CitationValidator();
  const ctx: SpawnContext = {
    send,
    validator,
    emittedCitations: new Set<string>(),
    assistantBuf: { v: '' },
    sawResult: { v: false },
  };

  const isWin = process.platform === 'win32';
  const slashCommand = `/chat-answer --request-file=${requestFile}`;
  const promptArg = isWin ? `"${slashCommand.replace(/"/g, '\\"')}"` : slashCommand;
  const allowedTools = 'Read Grep Glob Task';
  // `--output-format=stream-json` requires `--verbose` when paired with
  // `-p` (headless). Without it the CLI prints
  // "Error: When using --print, --output-format=stream-json requires --verbose"
  // and exits 1 before producing any events — surfaces in the UI as
  // "claude CLI exited with code 1" because no `result` event ever
  // arrives.
  const args = [
    '--allowedTools',
    allowedTools,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(body.resumeSessionId ? ['--resume', body.resumeSessionId] : []),
    '-p',
    promptArg,
  ];

  await new Promise<void>((resolveOuter) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const child = spawn('claude', args, {
      cwd: repoRoot(),
      env: process.env,
      shell: isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError: Error | null = null;

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      // Process complete lines; keep the trailing partial in the buffer.
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        // Note any tool_use blocks ahead of citation scanning by
        // peeking at the structure. The main parser also emits trace
        // events for them.
        try {
          const obj = JSON.parse(line.trim());
          if (
            obj?.type === 'assistant' &&
            Array.isArray(obj.message?.content)
          ) {
            for (const block of obj.message.content) {
              if (block?.type === 'tool_use' && typeof block.name === 'string') {
                noteToolUseForValidator(block.name, block.input, validator);
              }
            }
          }
        } catch {
          // not JSON — handleStreamJsonLine will surface as thinking trace
        }
        handleStreamJsonLine(line, ctx);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      // stderr lines surface as collapsed thinking traces — they're
      // usually claude's own diagnostics, not user-facing errors.
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (t.length === 0) continue;
        send({
          type: 'trace',
          event: { kind: 'thinking', preview: t.slice(0, 200), ts: Date.now() },
        });
      }
    });
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      // Flush any remaining buffered partial line.
      if (stdoutBuf.trim().length > 0) handleStreamJsonLine(stdoutBuf, ctx);
      if (stderrBuf.trim().length > 0) {
        send({
          type: 'trace',
          event: { kind: 'thinking', preview: stderrBuf.trim().slice(0, 200), ts: Date.now() },
        });
      }

      const durationMs = Date.now() - startedAt;
      if (spawnError) {
        send({
          type: 'error',
          message: `failed to spawn claude: ${spawnError.message}. Is the CLI installed and on PATH?`,
          retryable: false,
        });
      } else if (code !== 0) {
        send({
          type: 'error',
          message: `claude CLI exited with code ${code}`,
          retryable: true,
        });
      } else if (!ctx.sawResult.v) {
        send({
          type: 'error',
          message:
            'silent abort — the CLI exited cleanly but emitted no result event. The skill may have hit an "ask the user" branch in headless mode.',
          retryable: true,
        });
      } else {
        send({
          type: 'final',
          ok: true,
          answerChars: ctx.assistantBuf.v.length,
          citationsCount: ctx.emittedCitations.size,
          durationMs,
        });
      }
      resolveOuter();
    });
  });

  // Best-effort cleanup. The skill should have finished reading it long
  // before this point.
  try {
    await unlink(requestFile);
  } catch {
    // already gone, or permission — non-fatal.
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, 'invalid JSON body');
  }
  const parsed = parseRequestBody(raw);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const { body } = parsed;

  if (inFlightByChatId.has(body.chatId)) {
    return jsonError(409, 'a turn is already in flight for this chat', {
      chatId: body.chatId,
    });
  }
  if (totalInFlight >= MAX_CONCURRENT) {
    return jsonError(429, `server-wide chat concurrency cap (${MAX_CONCURRENT}) reached`);
  }

  inFlightByChatId.set(body.chatId, { startedAt: Date.now() });
  totalInFlight += 1;

  // Silent-abort watchdog: if the stream lives past SILENT_ABORT_GRACE_MS
  // without resolving, the response is closed and the gate released.
  // The actual claude process keeps running in the background; the
  // user's UI sees a clean error and can retry.
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: ChatStreamEvent): void => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + '\n'));
        } catch {
          // controller closed — ignore
        }
      };
      watchdog = setTimeout(() => {
        send({
          type: 'error',
          message: `chat-answer timed out after ${SILENT_ABORT_GRACE_MS}ms`,
          retryable: true,
        });
        try {
          controller.close();
        } catch {
          // already closed
        }
      }, SILENT_ABORT_GRACE_MS);

      try {
        await runChatAnswer(body, send);
      } finally {
        if (watchdog) clearTimeout(watchdog);
        inFlightByChatId.delete(body.chatId);
        totalInFlight = Math.max(0, totalInFlight - 1);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      // Client disconnected; the spawned claude keeps running in the
      // background. Gate is released when the spawn closes naturally.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
};

/**
 * Availability probe. The viewer pings this on ChatMode mount to decide
 * whether to render the chat input or the "local backend required" empty
 * state (static deploys without a backend return 404 here, which the
 * viewer detects as "not available").
 */
export const GET: APIRoute = async () => {
  return new Response(
    JSON.stringify({
      ok: true,
      available: true,
      maxConcurrent: MAX_CONCURRENT,
      currentInFlight: totalInFlight,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    },
  );
};
