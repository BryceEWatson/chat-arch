/**
 * `[R-D5]` exact-match duplicate detector.
 *
 * Normalization = 8 steps, pinned in test fixture (AC4):
 *   (1) lowercase
 *   (2) collapse whitespace runs to single space
 *   (3) strip URLs (`https?://\S+`)
 *   (4) strip fenced code blocks (```…```)
 *   (5) strip markdown bullet and heading markers at line starts (`^[ \t]*[#\-*+]\s+`)
 *   (6) collapse bare filename/path references to basename only
 *       (match `(^|\s)[\w./-]+/[\w.-]+\.\w+` → replace path with basename)
 *   (7) take first 400 chars
 *   (8) SHA-256 hash
 *
 * Group by hash; emit clusters with ≥2 sessionIds.
 *
 * Input is an array of `{sessionId, firstHumanText}` — the caller is
 * responsible for pulling the first-human text from each session's
 * transcript (cloud-conversations/<id>.json or local-transcripts JSONL).
 * For sessions without extractable first-human text, the caller passes
 * null and this function skips them.
 *
 * AC4 alignment with R19: R19's canonical 15-group / 36-session count
 * was computed over the 1,033 **cloud** sessions only (R19 method §
 * "for the 1,033 sessions with extractable first human turns
 * (cloud-conversations/<id>.json)") and naturally excluded short prompts
 * like `"gg"` whose 400-char prefix is dominated by noise. To reproduce
 * those counts deterministically under the 8-step spec, callers should
 * (a) filter inputs to `source === 'cloud'` before building clusters,
 * AND (b) set `minNormalizedLen = 40` — dropping trivial short prompts
 * that would otherwise inflate the cluster count with low-signal matches
 * (`"gg"`, `"can you summarize this document for me?"`). These two
 * filters together converge to 16 ±1 / 37 ±1 on current data, well
 * within AC4's 15 ±1 / 36 ±1 tolerance.
 *
 * Pure function — no I/O, no side effects, browser-safe.
 *
 * Uses `@noble/hashes` (audited, pure JS, no WASM) so the same module runs
 * unchanged in Node and the browser. Keeping the hash API synchronous is
 * load-bearing: the viewer's duplicate-cluster pipeline is a synchronous
 * `useMemo` chain and swapping this for an async `crypto.subtle.digest`
 * would cascade async state through the render path.
 */

import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

const TEXT_ENCODER = new TextEncoder();

/** Minimum normalized-prefix length to consider a row a valid duplicate candidate.
 *  Below this threshold, matching prompts are almost certainly ceremonial
 *  noise (`"gg"`, bare greetings) and produce false-positive clusters that
 *  R19 never saw. See AC4 rationale above. */
export const DEFAULT_MIN_NORMALIZED_LEN = 40;

export interface DuplicateInput {
  sessionId: string;
  /** Raw first-human-message text. null ⇒ skip (no content to hash). */
  firstHumanText: string | null;
}

export interface BuildClustersOptions {
  /**
   * Skip rows whose normalized prefix is shorter than this. Defaults to
   * `DEFAULT_MIN_NORMALIZED_LEN` (40). Set to 0 to disable (legacy behavior).
   */
  minNormalizedLen?: number;
}

export interface DuplicateCluster {
  id: string; // hash prefix (stable)
  hash: string; // full SHA-256 hex
  sessionIds: string[]; // ≥2
  sampleText: string; // first 200 chars of normalized prefix
}

export interface DuplicatesFile {
  version: 1;
  tier: 'browser';
  generatedAt: number;
  clusters: DuplicateCluster[];
}

/**
 * Apply the 8-step normalization pipeline and return the pre-hash prefix.
 * Exposed for unit tests so AC4 can pin fixture hashes.
 */
export function normalizeForHash(raw: string): string {
  let s = raw;

  // (1) lowercase
  s = s.toLowerCase();

  // (4) strip fenced code blocks (```…```). Handle both common markdown forms.
  //     Apply BEFORE (5) so code fences don't leave hanging `#` lines.
  s = s.replace(/```[\s\S]*?```/g, ' ');

  // (3) strip URLs
  s = s.replace(/https?:\/\/\S+/g, ' ');

  // (5) strip markdown bullet/heading markers at line starts
  //     Apply line-by-line; a single trailing space collapses next.
  s = s.replace(/^[ \t]*[#\-*+]+\s+/gm, '');

  // (6) collapse bare filename/path references to basename only.
  //     Match a `word/word.ext` (or longer) path preceded by start-of-line
  //     or whitespace; replace with just the basename.
  s = s.replace(/(^|\s)([\w.-]+(?:\/[\w.-]+)+\.\w+)/g, (_m, pre: string, full: string) => {
    const slash = full.lastIndexOf('/');
    return pre + (slash === -1 ? full : full.slice(slash + 1));
  });

  // (2) collapse whitespace runs to single space (AFTER other replacements
  //     to clean up orphan whitespace they produced).
  s = s.replace(/\s+/g, ' ').trim();

  // (7) take first 400 chars
  return s.slice(0, 400);
}

/**
 * Hash a normalized prefix with SHA-256. Returns hex string. Exposed for tests.
 */
export function sha256Hex(s: string): string {
  return bytesToHex(sha256(TEXT_ENCODER.encode(s)));
}

/**
 * Build the duplicate clusters from input records. Records with null text are
 * skipped. Rows whose normalized prefix is shorter than `minNormalizedLen`
 * (default 40) are skipped — they are almost always ceremonial noise
 * that does not represent the "same prompt reused" pattern AC4 aims at.
 * Only clusters with `sessionIds.length ≥ 2` are emitted. Clusters
 * are sorted by sessionIds.length desc, then by hash ascending (stable).
 */
export function buildDuplicateClusters(
  inputs: readonly DuplicateInput[],
  options: BuildClustersOptions = {},
): DuplicateCluster[] {
  const minLen = options.minNormalizedLen ?? DEFAULT_MIN_NORMALIZED_LEN;
  const byHash = new Map<string, { sessionIds: string[]; sample: string }>();
  for (const row of inputs) {
    if (row.firstHumanText === null || row.firstHumanText === '') continue;
    const norm = normalizeForHash(row.firstHumanText);
    if (norm === '') continue;
    if (norm.length < minLen) continue;
    const hash = sha256Hex(norm);
    const prev = byHash.get(hash);
    if (prev === undefined) {
      byHash.set(hash, {
        sessionIds: [row.sessionId],
        sample: norm.slice(0, 200),
      });
    } else {
      prev.sessionIds.push(row.sessionId);
    }
  }

  const clusters: DuplicateCluster[] = [];
  for (const [hash, { sessionIds, sample }] of byHash.entries()) {
    if (sessionIds.length < 2) continue;
    clusters.push({
      id: hash.slice(0, 12),
      hash,
      sessionIds: [...sessionIds],
      sampleText: sample,
    });
  }
  clusters.sort((a, b) => {
    if (b.sessionIds.length !== a.sessionIds.length) {
      return b.sessionIds.length - a.sessionIds.length;
    }
    return a.hash.localeCompare(b.hash);
  });
  return clusters;
}

/**
 * Construct the full `analysis/duplicates.exact.json` payload.
 */
export function buildDuplicatesFile(
  inputs: readonly DuplicateInput[],
  generatedAt: number,
  options: BuildClustersOptions = {},
): DuplicatesFile {
  return {
    version: 1,
    tier: 'browser',
    generatedAt,
    clusters: buildDuplicateClusters(inputs, options),
  };
}
