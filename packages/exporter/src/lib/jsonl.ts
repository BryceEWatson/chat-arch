import { createReadStream } from 'node:fs';
import readline from 'node:readline';

/**
 * Yielded shape: either a parsed line or a parse-error record.
 *
 * The reader NEVER throws on malformed lines — callers decide whether to
 * skip or fail. Empty lines are silently skipped.
 *
 * Phase 3 consumes this same helper for CLI transcripts; the parsed-JSON
 * yield satisfies Phase 3's `event.cwd` extraction need (per CONTRADICTIONS
 * C3, cwd must be read from transcript content, not dir name).
 */
export type JsonlYield<T> =
  | { kind: 'ok'; line: T; lineNumber: number }
  | { kind: 'error'; error: Error; lineNumber: number; raw: string };

/** Stream a JSONL file line-by-line. Constant memory per file. */
export async function* readJsonlLines<T = unknown>(
  filePath: string,
): AsyncGenerator<JsonlYield<T>> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const raw of rl) {
      lineNumber += 1;
      if (raw.length === 0) continue;
      try {
        const parsed = JSON.parse(raw) as T;
        yield { kind: 'ok', line: parsed, lineNumber };
      } catch (err) {
        yield {
          kind: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
          lineNumber,
          raw,
        };
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
