import { readJsonlLines } from './jsonl.js';

/**
 * Tool-use counting, shared between sources.
 *
 * Input shape: the `message` field of a local transcript `assistant` line,
 * which mirrors the Anthropic Messages API response:
 *
 *   { role: 'assistant', content: [
 *       { type: 'text', text: '...' },
 *       { type: 'tool_use', id: 'toolu_…', name: 'Bash', input: {...} },
 *       { type: 'thinking', thinking: '...' },
 *       ...
 *   ]}
 *
 * We tally every `tool_use` block by `name`. Text / thinking / tool_result
 * blocks are ignored. Unknown block types are ignored silently — callers
 * already log malformed-line counts via their own pass and we don't want
 * duplicate drift warnings.
 *
 * String-content messages (rare on assistant lines but technically valid)
 * carry no tool_use by definition — they no-op.
 */
export function countToolUsesInMessage(message: unknown, acc: Record<string, number>): void {
  if (typeof message !== 'object' || message === null) return;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; name?: unknown };
    if (b.type !== 'tool_use') continue;
    if (typeof b.name !== 'string' || b.name.length === 0) continue;
    acc[b.name] = (acc[b.name] ?? 0) + 1;
  }
}

/**
 * Standalone streaming tally — walks a JSONL transcript once and returns
 * the tool_use histogram. Constant memory. Used by `cowork.ts`, which
 * already aggregates turn/cost data from `audit.jsonl` and needs the
 * transcript only for tool_use extraction.
 *
 * Never throws: malformed lines are silently skipped. Missing / unreadable
 * files surface as the empty map — the caller's conditional-spread keeps
 * `topTools` absent when nothing was found.
 *
 * cli.ts has its own streaming pass and calls {@link countToolUsesInMessage}
 * inline rather than round-tripping the file twice.
 */
export async function streamToolUses(transcriptPath: string): Promise<Record<string, number>> {
  const acc: Record<string, number> = {};
  try {
    for await (const y of readJsonlLines<Record<string, unknown>>(transcriptPath)) {
      if (y.kind === 'error') continue;
      const line = y.line;
      if (line['type'] !== 'assistant') continue;
      countToolUsesInMessage(line['message'], acc);
    }
  } catch {
    // File unreadable — caller gets {} and drops the field.
  }
  return acc;
}
