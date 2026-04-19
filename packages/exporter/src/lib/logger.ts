/**
 * Tiny logger with `warnOnce` semantics per-key.
 *
 * All output goes to stderr. Tests may call `setSink()` to capture or
 * suppress output, then `resetForTests()` to restore defaults + clear the
 * warn-once set between tests.
 */

type Sink = (line: string) => void;

const defaultSink: Sink = (line: string) => {
  console.error(line);
};

let sink: Sink = defaultSink;
const warnedKeys = new Set<string>();

export const logger = {
  info(message: string): void {
    sink(`[chat-arch] ${message}`);
  },
  warn(message: string): void {
    sink(`[chat-arch] WARN: ${message}`);
  },
  /** Emit a WARN the first time `key` is seen; subsequent calls are silent. */
  warnOnce(key: string, message: string): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    sink(`[chat-arch] WARN: ${message}`);
  },
  error(message: string): void {
    sink(`[chat-arch] ERROR: ${message}`);
  },

  /** Test hook — override the destination sink. */
  setSink(custom: Sink): void {
    sink = custom;
  },
  /** Test hook — clear warn-once set and restore default sink. */
  resetForTests(): void {
    sink = defaultSink;
    warnedKeys.clear();
  },
  /** Test hook — inspect current warn-once set size. */
  _warnedKeyCount(): number {
    return warnedKeys.size;
  },
};
