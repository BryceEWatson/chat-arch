import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TokenTotals } from '@chat-arch/schema';
import { readJsonlLines } from './jsonl.js';
import { countToolUsesInMessage } from './toolUses.js';

/**
 * Per-session subagent rollup. Cowork and host-CLI sessions can fan out to
 * sub-agents (Task tool invocations); each sub-agent gets its own transcript
 * under `<sessionDir>/.../subagents/agent-*.jsonl`. They typically run on a
 * smaller/faster model (Haiku) and execute their own tool calls. Without
 * walking them, parent-session `tokenTotals` / `topTools` / `modelsUsed`
 * undercount heavy-fan-out sessions by 10x+.
 *
 * `count` is the number of subagent JSONL files (one file per Task invocation);
 * `totalTokens` / `topTools` / `modelsUsed` are summed across all files.
 */
export interface SubagentRollup {
  count: number;
  totalTokens: TokenTotals;
  modelsUsed: readonly string[];
  topTools: Readonly<Record<string, number>>;
}

const SUBAGENT_FILE_RE = /^agent-.*\.jsonl$/i;

/**
 * Walk a `subagents/` directory and produce a rollup of all `agent-*.jsonl`
 * sub-agent transcripts. Same JSONL-stream-and-accumulate pattern as
 * `streamToolUses` (lib/toolUses.ts); reads each file once, constant memory.
 *
 * Returns `undefined` when the directory is missing — most sessions don't
 * fan out, and that's not an error. Malformed lines and unreadable individual
 * files are silently skipped so a single corrupt subagent doesn't lose the
 * rest of the rollup.
 */
export async function aggregateSubagents(
  subagentsDir: string,
): Promise<SubagentRollup | undefined> {
  let entries: string[];
  try {
    entries = await readdir(subagentsDir);
  } catch {
    return undefined;
  }

  const files = entries.filter((n) => SUBAGENT_FILE_RE.test(n));
  if (files.length === 0) return undefined;

  const totalTokens: TokenTotals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const modelsSeen = new Set<string>();
  const modelsOrdered: string[] = [];
  const topTools: Record<string, number> = {};

  for (const name of files) {
    const filePath = path.join(subagentsDir, name);
    try {
      for await (const y of readJsonlLines<Record<string, unknown>>(filePath)) {
        if (y.kind === 'error') continue;
        const line = y.line;
        if (line['type'] !== 'assistant') continue;
        const msg = line['message'] as
          | {
              model?: unknown;
              usage?: {
                input_tokens?: unknown;
                output_tokens?: unknown;
                cache_creation_input_tokens?: unknown;
                cache_read_input_tokens?: unknown;
              };
            }
          | undefined;
        if (msg && typeof msg.model === 'string' && msg.model.length > 0) {
          if (!modelsSeen.has(msg.model)) {
            modelsSeen.add(msg.model);
            modelsOrdered.push(msg.model);
          }
        }
        if (msg && msg.usage) {
          const u = msg.usage;
          if (typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens)) {
            totalTokens.input += u.input_tokens;
          }
          if (typeof u.output_tokens === 'number' && Number.isFinite(u.output_tokens)) {
            totalTokens.output += u.output_tokens;
          }
          if (
            typeof u.cache_creation_input_tokens === 'number' &&
            Number.isFinite(u.cache_creation_input_tokens)
          ) {
            totalTokens.cacheCreation += u.cache_creation_input_tokens;
          }
          if (
            typeof u.cache_read_input_tokens === 'number' &&
            Number.isFinite(u.cache_read_input_tokens)
          ) {
            totalTokens.cacheRead += u.cache_read_input_tokens;
          }
        }
        countToolUsesInMessage(line['message'], topTools);
      }
    } catch {
      // Single corrupt subagent file — skip it, keep the rest of the rollup.
    }
  }

  return {
    count: files.length,
    totalTokens,
    modelsUsed: modelsOrdered,
    topTools,
  };
}

/** Helper: sum two TokenTotals. Pure. */
export function sumTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

/** Helper: sum two name→count histograms into a new object. Pure. */
export function sumHistograms(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/** Helper: union arrays preserving insertion order of `a` first, then new from `b`. */
export function uniqueModels(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of a) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  for (const m of b) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}
