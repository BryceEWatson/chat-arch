/**
 * Unwrap Claude Code / Cowork harness envelopes from raw user-turn text
 * so SUMMARY contexts (card previews, title fallbacks, evidence excerpts,
 * persona Evidence rows) surface the user's actual content instead of
 * harness boilerplate.
 *
 * Detail-pane transcript rendering should NOT call this — the user is
 * reading the full conversation there and the wrappers are part of the
 * transcript. This helper exists for the leak-into-summary case
 * documented in `research/ui-content-issues.md` (root cause for ~15-20
 * surfaced sites).
 *
 * Behavior:
 *   - `<command-message>X</command-message>` + `<command-name>/Y</command-name>`
 *     + `<command-args>Z</command-args>` → `/Y Z` (or `/Y` if no args).
 *     Trailing user prose after the triple is preserved.
 *   - `<scheduled-task name="X" ...>...</scheduled-task>` → `↻ scheduled-task: X`.
 *   - Lines starting with `<system-reminder>`, `<task-notification>`,
 *     `<local-command-stdout>`, `<local-command-stderr>`, `<bash-stdout>`,
 *     `<bash-stderr>`, `<uploaded_files>`, `<file>`, `<file_path>`,
 *     `<file_uuid>`, `Base directory for this skill:`,
 *     `Caveat: The messages below were generated`,
 *     `This session is being continued from a previous conversation`,
 *     `[Request interrupted by user` — dropped (multi-line block stripped
 *     through closing tag where applicable).
 *   - Empty result → `null` (no display string; callers should use a
 *     fallback like `(no preview)` rather than render whitespace).
 *
 * NOTE: this file was ported byte-for-byte from the concurrent
 * UI-content / `unwrapEnvelope` branch (1.8.0) so the decisions UI can
 * unwrap excerpts while based off `main`. Whichever PR merges second
 * hits a trivial add/add conflict here and on the `export` line in
 * `index.ts` — resolve by keeping either (identical) copy. On THAT
 * branch this helper is also wired into
 * `packages/exporter/src/analysis/personaCandidates.ts` as the primary
 * unwrap stage (with a local `WRAPPER_PREFIXES` defense-in-depth
 * filter); that wiring is NOT part of this branch.
 */

const SCHEDULED_TASK_RE = /<scheduled-task\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?(?:<\/scheduled-task>|$)/g;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_MESSAGE_BLOCK_RE = /<command-message>[\s\S]*?<\/command-message>\s*/g;
const COMMAND_NAME_BLOCK_RE = /<command-name>[\s\S]*?<\/command-name>\s*/g;
const COMMAND_ARGS_BLOCK_RE = /<command-args>[\s\S]*?<\/command-args>\s*/g;

const LINE_WRAPPER_TAGS: readonly string[] = [
  'system-reminder',
  'task-notification',
  'local-command-stdout',
  'local-command-stderr',
  'bash-stdout',
  'bash-stderr',
  'uploaded_files',
  'file',
  'file_path',
  'file_uuid',
];

const LINE_WRAPPER_LITERALS: readonly string[] = [
  'Base directory for this skill:',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous conversation',
  '[Request interrupted by user',
];

export function unwrapEnvelope(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let result = trimmed;

  // 1. scheduled-task envelope → "↻ scheduled-task: <name>"
  result = result.replace(SCHEDULED_TASK_RE, '↻ scheduled-task: $1');

  // 2. Slash-command triple → "/name args" (preserve any trailing prose)
  const nameMatch = COMMAND_NAME_RE.exec(result);
  if (nameMatch) {
    const rawName = (nameMatch[1] ?? '').trim();
    const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
    const argsMatch = COMMAND_ARGS_RE.exec(result);
    const args = argsMatch ? (argsMatch[1] ?? '').trim() : '';
    const synthesized = args.length > 0 ? `/${name} ${args}` : `/${name}`;
    const stripped = result
      .replace(COMMAND_MESSAGE_BLOCK_RE, '')
      .replace(COMMAND_NAME_BLOCK_RE, '')
      .replace(COMMAND_ARGS_BLOCK_RE, '')
      .trim();
    result = stripped.length > 0 ? `${synthesized}\n${stripped}` : synthesized;
  }

  // 3. Drop multi-line wrapper blocks and single-line wrapper literals.
  const lines = result.split('\n');
  const kept: string[] = [];
  let skipUntilCloseTag: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (skipUntilCloseTag !== null) {
      if (t.includes(skipUntilCloseTag)) skipUntilCloseTag = null;
      continue;
    }
    const wrapperTag = LINE_WRAPPER_TAGS.find(
      (tag) => t.startsWith(`<${tag}>`) || t.startsWith(`<${tag} `),
    );
    if (wrapperTag !== undefined) {
      const closeTag = `</${wrapperTag}>`;
      if (!t.includes(closeTag)) skipUntilCloseTag = closeTag;
      continue;
    }
    if (LINE_WRAPPER_LITERALS.some((p) => t.startsWith(p))) continue;
    kept.push(line);
  }

  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out.length > 0 ? out : null;
}
