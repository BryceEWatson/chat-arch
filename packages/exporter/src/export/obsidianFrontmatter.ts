/**
 * YAML frontmatter serializer for Obsidian-flavored markdown exports.
 *
 * Hand-rolled (rather than pulling in `js-yaml`) because the surface is
 * narrow: scalars, ISO datetimes, numbers, booleans, null, and one-level
 * arrays of scalars. That covers every key the post-mortem and
 * knowledge-debt exporters emit. If a future export needs nested mappings
 * we should switch to a real library at that point.
 *
 * Obsidian-specific quirks honored:
 *   - keys serialized in insertion order (Obsidian uses this for
 *     "Properties" panel ordering).
 *   - YAML "1.2 core schema" booleans only (`true` / `false`) — Obsidian
 *     does NOT parse `yes`/`no`/`on`/`off`.
 *   - strings with YAML-significant chars (`: # > | & * ! % @ \`` etc.)
 *     get wrapped in double quotes with `\\` and `\"` escapes.
 *   - empty arrays render as `[]` (block-form `-` lists would be valid
 *     YAML but Obsidian's Properties panel shows them as a no-op).
 *
 * Output always ends with a single `\n` so the caller can concatenate
 * `--- frontmatter --- body`.
 */

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | readonly FrontmatterScalar[];
export type FrontmatterObject = Readonly<Record<string, FrontmatterValue>>;

/**
 * YAML 1.2 core-schema reserved scalars + the characters that flag a
 * line as needing quoting. We err toward over-quoting strings; the cost
 * is a few extra bytes and the benefit is "never parse-fails in
 * Obsidian's strict reader."
 */
const NEEDS_QUOTE = /[:#>|&*!%@`\\"\n\r\t{},[\]?]|^\s|\s$|^-\s|^(true|false|null|yes|no|on|off)$/i;

function quoteString(value: string): string {
  // Double-quote form so we don't have to handle YAML's single-quote
  // doubling rule. Escapes match JSON's set; YAML accepts those plus a
  // few more we don't need (\\N, \\L, \\P).
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function serializeScalar(value: FrontmatterScalar): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`obsidianFrontmatter: non-finite number cannot be serialized (got ${String(value)})`);
    }
    return String(value);
  }
  // string
  if (value === '') return '""';
  if (NEEDS_QUOTE.test(value)) return quoteString(value);
  return value;
}

function serializeArray(values: readonly FrontmatterScalar[]): string {
  if (values.length === 0) return '[]';
  return `[${values.map(serializeScalar).join(', ')}]`;
}

/**
 * Serialize an object to a fenced YAML frontmatter block.
 *
 *   ---
 *   key1: value1
 *   key2: [a, b]
 *   ---
 *
 * The trailing newline after the closing `---` is included so callers
 * can concatenate body content directly.
 */
export function serializeFrontmatter(obj: FrontmatterObject): string {
  const lines: string[] = ['---'];
  for (const [rawKey, value] of Object.entries(obj)) {
    // Keys are restricted to safe YAML identifiers; reject pathological
    // input loudly rather than emit broken YAML.
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(rawKey)) {
      throw new Error(`obsidianFrontmatter: unsafe key ${JSON.stringify(rawKey)} (must match /^[A-Za-z_][A-Za-z0-9_-]*$/)`);
    }
    if (Array.isArray(value)) {
      lines.push(`${rawKey}: ${serializeArray(value as readonly FrontmatterScalar[])}`);
    } else {
      lines.push(`${rawKey}: ${serializeScalar(value as FrontmatterScalar)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}
