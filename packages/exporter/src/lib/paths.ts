import path from 'node:path';

/**
 * Return `abs` relative to `base`, normalized to forward-slash POSIX form so
 * it is safe to embed in JSON output that a browser consumes.
 *
 * Throws if the result escapes `base` (i.e. starts with `..`). Schema
 * pointers must never reference files outside the exporter's output dir.
 */
export function toPosixRelative(abs: string, base: string): string {
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`[chat-arch] path ${abs} is not inside base ${base} (relative=${rel})`);
  }
  return rel.split(path.sep).join('/');
}
