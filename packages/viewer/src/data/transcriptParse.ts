import type { LocalTranscriptEntry } from '../types.js';

/**
 * Split a JSONL blob into per-line entries.
 *
 * Behavior (per plan decision 6):
 *   - Split by `\n`; ignore empty lines.
 *   - `JSON.parse` each line; success -> `{ type: 'known', line }`.
 *   - Failure -> `{ type: '_malformed', raw, error }` so the UI can surface it.
 *
 * Known line types (ai-title, user, assistant, attachment, last-prompt,
 * tool_use_summary, ...) are NOT filtered here — plan decision Q9 says render
 * all, defer toggle. The parser just shapes the data.
 */
export function parseTranscript(text: string): LocalTranscriptEntry[] {
  if (!text) return [];
  const out: LocalTranscriptEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    if (raw.trim() === '') continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push({ type: 'known', line: parsed as Record<string, unknown> });
      } else {
        out.push({ type: '_malformed', raw, error: 'not a JSON object' });
      }
    } catch (err) {
      out.push({
        type: '_malformed',
        raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

// Char budget for per-row previews. The TranscriptList body wraps
// (pre-wrap) so long extracts are readable, but caps keep the list
// scannable. Individual block previews are budgeted separately.
// Generous defaults mean most rows show their full content inline;
// the `<details>` expander is only surfaced for genuinely long
// bodies (see `EXPANDER_MIN_CHARS`).
const TOTAL_CAP = 1500;
const BLOCK_CAP = 600;

/**
 * Show the `<details>` expander on a row only when the full body
 * exceeds this many characters. Below this threshold we inline
 * everything we can fit into the preview — no redundant button on
 * short tool_use calls, short tool_results, single-block messages,
 * etc. Callers apply this via `shouldExpand()`.
 */
export const EXPANDER_MIN_CHARS = 1200;

/**
 * The UI gate for the "show full content" expander. Small bodies
 * never get one even if the preview format differs from the full
 * (e.g. `Bash · ls` vs the pretty-JSON of `{command: "ls"}`) —
 * there's nothing substantive to reveal.
 */
export function shouldExpand(preview: string, full: string): boolean {
  if (!full) return false;
  if (full === preview) return false;
  return full.length > EXPANDER_MIN_CHARS;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function clip(s: string, cap: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= cap) return flat;
  const overflow = flat.length - cap;
  return `${flat.slice(0, cap)}…(+${overflow} chars)`;
}

// Compact summary of a `tool_use` block: `Bash · <command>` when the
// input has a recognizable field, otherwise `Bash · {json}`. Input
// fields are tried in decreasing order of expressiveness.
function toolUseSummary(block: Record<string, unknown>): string {
  const name = asStr(block['name']) ?? 'tool';
  const input = asObj(block['input']);
  if (!input) return name;
  const prefKeys = [
    'command',
    'description',
    'prompt',
    'query',
    'pattern',
    'file_path',
    'path',
    'url',
    'notebook_path',
  ];
  for (const k of prefKeys) {
    const v = asStr(input[k]);
    if (v && v.trim()) return `${name} · ${clip(v, BLOCK_CAP)}`;
  }
  // Fall back to a JSON snippet of the first few keys.
  try {
    const keys = Object.keys(input).slice(0, 4);
    if (keys.length === 0) return name;
    const pairs = keys.map((k) => {
      const val = input[k];
      const s = typeof val === 'string' ? `"${val}"` : JSON.stringify(val);
      return `${k}: ${clip(s ?? '', 60)}`;
    });
    return `${name} · {${pairs.join(', ')}}`;
  } catch {
    return name;
  }
}

// `tool_result` blocks either carry a plain string in `.content` or a
// nested array of blocks (text/image). Errors bubble up with a prefix.
function toolResultSummary(block: Record<string, unknown>): string {
  const isError = block['is_error'] === true;
  const prefix = isError ? 'error · ' : '';
  const c = block['content'];
  if (typeof c === 'string') return `${prefix}${clip(c, BLOCK_CAP)}`;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const inner of c) {
      const b = asObj(inner);
      if (!b) continue;
      const t = b['type'];
      if (t === 'text') {
        const s = asStr(b['text']);
        if (s) parts.push(clip(s, BLOCK_CAP));
      } else if (t === 'image') {
        parts.push('(image)');
      } else {
        parts.push(`(${String(t ?? 'block')})`);
      }
    }
    return `${prefix}${parts.join(' · ')}`;
  }
  return `${prefix}(no content)`;
}

function thinkingSummary(block: Record<string, unknown>): string {
  const s = asStr(block['thinking']);
  if (s && s.trim()) return `thinking · ${clip(s, BLOCK_CAP)}`;
  // Encrypted/signed thinking blocks come through with an empty
  // `.thinking` field and a signature — nothing readable, but flag
  // it so the row isn't mysteriously blank.
  const sig = asStr(block['signature']);
  if (sig) return `thinking · (encrypted, ${sig.length} chars signature)`;
  return 'thinking · (empty)';
}

// One content block → one summary segment. Unknown types get a
// `(type)` breadcrumb rather than vanishing silently.
function contentBlockSummary(raw: unknown): string {
  if (typeof raw === 'string') return clip(raw, BLOCK_CAP);
  const b = asObj(raw);
  if (!b) return '';
  const t = asStr(b['type']);
  switch (t) {
    case 'text': {
      const s = asStr(b['text']);
      return s ? clip(s, BLOCK_CAP) : '';
    }
    case 'thinking':
      return thinkingSummary(b);
    case 'redacted_thinking':
      return 'thinking · (redacted)';
    case 'tool_use':
      return toolUseSummary(b);
    case 'tool_result':
      return toolResultSummary(b);
    case 'image':
      return '(image)';
    default:
      return t ? `(${t})` : '';
  }
}

// Attachments are polymorphic: file uploads carry `file_name`;
// deferred-tool deltas carry `addedNames`/`removedNames`; some are
// just typed markers. Extract whatever is most informative.
function attachmentSummary(line: Record<string, unknown>): string {
  const att = asObj(line['attachment']);
  if (!att) return 'attachment';
  const fname = asStr(att['file_name']);
  if (fname) return `attachment: ${fname}`;
  const t = asStr(att['type']);
  if (t === 'deferred_tools_delta') {
    const added = Array.isArray(att['addedNames']) ? (att['addedNames'] as unknown[]) : [];
    const removed = Array.isArray(att['removedNames']) ? (att['removedNames'] as unknown[]) : [];
    const bits: string[] = [];
    if (added.length)
      bits.push(`+${added.length} (${added.slice(0, 4).join(', ')}${added.length > 4 ? '…' : ''})`);
    if (removed.length)
      bits.push(
        `-${removed.length} (${removed.slice(0, 4).join(', ')}${removed.length > 4 ? '…' : ''})`,
      );
    return `deferred_tools_delta: ${bits.join(' ') || '(empty)'}`;
  }
  if (t) return `attachment (${t})`;
  return 'attachment';
}

function fileHistorySnapshotSummary(line: Record<string, unknown>): string {
  const isUpdate = line['isSnapshotUpdate'] === true;
  const snap = asObj(line['snapshot']);
  const backups = snap ? asObj(snap['trackedFileBackups']) : null;
  const count = backups ? Object.keys(backups).length : 0;
  return `${isUpdate ? 'snapshot update' : 'snapshot'} · ${count} tracked file${count === 1 ? '' : 's'}`;
}

function queueOperationSummary(line: Record<string, unknown>): string {
  const op = asStr(line['operation']);
  const content = asStr(line['content']);
  if (content) return `${op ?? 'queue'} · ${clip(content, BLOCK_CAP)}`;
  return op ?? 'queue operation';
}

/**
 * Best-effort text preview for a transcript line, rendered as the
 * body beneath the row header in DetailMode. Falls back to a short
 * type breadcrumb (e.g. `(tool_use)`) rather than an empty string so
 * every row in the list reads as something.
 */
export function lineTextPreview(line: Record<string, unknown>): string {
  const type = String(line['type'] ?? 'unknown');

  // Top-level typed rows with their own shape.
  if (type === 'ai-title') return asStr(line['aiTitle']) ?? '';
  if (type === 'last-prompt') return asStr(line['lastPrompt']) ?? '';
  if (type === 'attachment') return attachmentSummary(line);
  if (type === 'file-history-snapshot') return fileHistorySnapshotSummary(line);
  if (type === 'queue-operation') return queueOperationSummary(line);

  // user / assistant: drill into `.message.content` (string or array).
  const msg = asObj(line['message']);
  if (msg) {
    const content = msg['content'];
    if (typeof content === 'string') return clip(content, TOTAL_CAP);
    if (Array.isArray(content)) {
      const parts = content.map(contentBlockSummary).filter(Boolean);
      if (parts.length === 0) return '';
      return clip(parts.join(' · '), TOTAL_CAP);
    }
  }

  return '';
}

// ==========================================================================
// Full-body extractors — used by the <details> expander so users can read
// the complete payload without the 600-char preview cap. These return raw,
// unabridged strings; multi-block messages are joined with block headers
// so each piece stays identifiable.

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function toolUseFull(block: Record<string, unknown>): string {
  const name = asStr(block['name']) ?? 'tool';
  const input = block['input'];
  const body = input !== undefined ? prettyJson(input) : '(no input)';
  return `[tool_use · ${name}]\n${body}`;
}

function toolResultFull(block: Record<string, unknown>): string {
  const isError = block['is_error'] === true;
  const tag = isError ? 'tool_result · error' : 'tool_result';
  const c = block['content'];
  let body: string;
  if (typeof c === 'string') body = c;
  else if (Array.isArray(c)) {
    body = c
      .map((inner) => {
        const b = asObj(inner);
        if (!b) return '';
        const t = asStr(b['type']);
        if (t === 'text') return asStr(b['text']) ?? '';
        if (t === 'image') return '(image)';
        return prettyJson(b);
      })
      .filter(Boolean)
      .join('\n\n');
  } else body = '(no content)';
  return `[${tag}]\n${body}`;
}

function thinkingFull(block: Record<string, unknown>): string {
  const s = asStr(block['thinking']);
  if (s && s.trim()) return `[thinking]\n${s}`;
  const sig = asStr(block['signature']);
  if (sig)
    return `[thinking · encrypted]\n(${sig.length} chars of base64 signature; content not readable)`;
  return '[thinking]\n(empty)';
}

function contentBlockFull(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const b = asObj(raw);
  if (!b) return '';
  const t = asStr(b['type']);
  switch (t) {
    case 'text':
      return asStr(b['text']) ?? '';
    case 'thinking':
      return thinkingFull(b);
    case 'redacted_thinking':
      return '[thinking · redacted]';
    case 'tool_use':
      return toolUseFull(b);
    case 'tool_result':
      return toolResultFull(b);
    case 'image':
      return '[image]';
    default:
      return t ? `[${t}]\n${prettyJson(b)}` : prettyJson(b);
  }
}

function attachmentFull(line: Record<string, unknown>): string {
  const att = asObj(line['attachment']);
  if (!att) return '';
  // File uploads: show extracted_content (already pre-rendered text).
  const fname = asStr(att['file_name']);
  const extracted = asStr(att['extracted_content']);
  if (fname && extracted) return `[attachment · ${fname}]\n${extracted}`;
  if (fname) return `[attachment · ${fname}]\n(no extracted content)`;
  // Structured deltas and other typed markers — just pretty-print the
  // full attachment object so nothing hides.
  return prettyJson(att);
}

function fileHistorySnapshotFull(line: Record<string, unknown>): string {
  const snap = asObj(line['snapshot']);
  const backups = snap ? asObj(snap['trackedFileBackups']) : null;
  if (!backups) return '';
  const files = Object.keys(backups);
  if (files.length === 0) return '(no tracked files)';
  return files.join('\n');
}

function queueOperationFull(line: Record<string, unknown>): string {
  const op = asStr(line['operation']) ?? 'queue';
  const content = asStr(line['content']);
  if (content) return `[${op}]\n${content}`;
  // Nothing more than the summary — caller will detect equality and
  // skip rendering the expander.
  return op;
}

/**
 * Unabridged body for a transcript line. Intended for a `<details>`
 * expander — callers compare against `lineTextPreview` and only show
 * the expander when the two differ (otherwise the expansion would
 * just repeat the summary).
 *
 * Multi-block messages are joined with `\n\n---\n\n` and each block
 * is prefixed with a bracketed label so thinking / tool_use /
 * tool_result / image pieces remain individually legible.
 */
export function lineFullBody(line: Record<string, unknown>): string {
  const type = String(line['type'] ?? 'unknown');

  if (type === 'ai-title') return asStr(line['aiTitle']) ?? '';
  if (type === 'last-prompt') return asStr(line['lastPrompt']) ?? '';
  if (type === 'attachment') return attachmentFull(line);
  if (type === 'file-history-snapshot') return fileHistorySnapshotFull(line);
  if (type === 'queue-operation') return queueOperationFull(line);

  const msg = asObj(line['message']);
  if (msg) {
    const content = msg['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content.map(contentBlockFull).filter(Boolean);
      if (parts.length === 0) return '';
      return parts.join('\n\n---\n\n');
    }
  }

  return '';
}
