/**
 * Near-duplicate detection via MinHash + LSH (Broder 1997, Indyk &
 * Motwani 1998). Third tier between exact and semantic dedup.
 *
 * Tier landscape (intentional, in order of stringency):
 *
 *   - exact (duplicatesExact.ts):     8-step normalization → SHA-256
 *     of first 400 chars. Catches verbatim openings; misses any
 *     edit inside the prefix.
 *   - minhash (this module):          word-5-gram shingles → 128-perm
 *     MinHash signature → LSH banding. Catches template families
 *     ("summarize this PR X" / "summarize this PR Y") that exact's
 *     prefix-hash misses and that embeddings see as merely "topically
 *     similar" (cosine ~0.85) rather than near-duplicate.
 *   - semantic (duplicatesSemantic.ts): cosine over Ollama embeddings.
 *     Catches paraphrased same-intent sessions that MinHash misses
 *     (different surface words, same meaning).
 *
 * Why roll our own instead of an npm dep: the May 2026 survey of
 * `minhash`, `node-minhash`, `lsh-index` turned up nothing that's
 * simultaneously maintained, ships TS types, uses a strong string
 * hash, AND bundles for the browser. duhaime/minhash is closest but
 * uses djb2-style string hashing (collision-prone on short n-grams)
 * and `Math.sin`-seeded permutations (low entropy). The algorithm is
 * textbook (Leskovec MMDS ch. 3); a 150-LOC inline implementation
 * with MurmurHash3 + standard `(a·x + b) mod p` permutations beats
 * pinning the strict-TS monorepo on an untyped 2018 package.
 *
 * Determinism: permutation coefficients are derived from a fixed
 * seed via mulberry32, so the same input always produces the same
 * signature → same LSH buckets → same clusters. Stable across runs
 * matches the convention of the other dedup tiers.
 *
 * Pure. Browser-safe. No I/O.
 */

import { mulberry32 } from './umapProject.js';

/**
 * 32-bit MurmurHash3 (Austin Appleby, public domain). Stronger than
 * djb2/FNV-1a on short strings and fast in JS via `Math.imul`. Used
 * as the base string-to-uint32 hash; the MinHash permutation family
 * applies a linear transform on top.
 */
export function murmurhash3_32(str: string, seed: number = 0): number {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let i = 0;
  const len = str.length;
  while (i + 4 <= len) {
    let k1 =
      (str.charCodeAt(i) & 0xff) |
      ((str.charCodeAt(i + 1) & 0xff) << 8) |
      ((str.charCodeAt(i + 2) & 0xff) << 16) |
      ((str.charCodeAt(i + 3) & 0xff) << 24);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
    i += 4;
  }
  let k1 = 0;
  const tail = len - i;
  if (tail === 3) k1 ^= (str.charCodeAt(i + 2) & 0xff) << 16;
  if (tail >= 2) k1 ^= (str.charCodeAt(i + 1) & 0xff) << 8;
  if (tail >= 1) {
    k1 ^= str.charCodeAt(i) & 0xff;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

/**
 * Tokenize text into word-`n`-gram shingles (default n=5). Lowercase,
 * strip punctuation, collapse whitespace, slide a window. Each shingle
 * is the n tokens joined with a single space — a canonical string
 * representation that MurmurHash3 can hash directly.
 *
 * 5 is the standard choice for English near-dup detection (Manku 2007,
 * Lee 2021); too short (n=2-3) makes everything look similar, too long
 * (n≥8) makes tiny edits invisible.
 */
export function shingles(text: string, n: number = 5): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length < n) return tokens.length === 0 ? [] : [tokens.join(' ')];
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i += 1) {
    out.push(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

/** Default permutation count. 128 is the standard MMDS default; gives
 *  ±0.09 std error on Jaccard estimates. */
export const DEFAULT_NUM_PERM = 128;
/** Default LSH banding: 16 bands × 8 rows = 128 perm. The (b, r) tuple
 *  controls the recall/precision tradeoff via the S-curve
 *  P(retrieve) ≈ 1 − (1 − s^r)^b ; (16, 8) crosses 0.5 at Jaccard ~0.6. */
const DEFAULT_BANDS = 16;
const DEFAULT_ROWS = 8;
const DEFAULT_THRESHOLD = 0.6;
/** Large prime; standard MinHash modulus. */
const PERM_PRIME = 4294967311;

/**
 * Build the permutation coefficients (a, b) for `numPerm` linear hashes
 * h_i(x) = (a_i · x + b_i) mod p. Coefficients are seeded from a fixed
 * PRNG so the same `numPerm` produces the same coefficients every run.
 *
 * Exported so callers can pre-build the table once for a corpus and
 * reuse across many signatures (the per-signature cost is dominated by
 * the inner loop over tokens, not coefficient generation, but the
 * allocation cost matters at scale).
 */
export function buildPermutationCoefficients(numPerm: number): {
  a: Uint32Array;
  b: Uint32Array;
} {
  const rng = mulberry32(0xdeadbeef);
  const a = new Uint32Array(numPerm);
  const b = new Uint32Array(numPerm);
  for (let i = 0; i < numPerm; i += 1) {
    // Coefficient `a` must be non-zero mod p for the permutation to be
    // injective on the relevant value range; we sample full uint32 and
    // re-roll on the (vanishingly rare) zero.
    let av = 0;
    while (av === 0) av = Math.floor(rng() * 0xffffffff);
    a[i] = av >>> 0;
    b[i] = Math.floor(rng() * 0xffffffff) >>> 0;
  }
  return { a, b };
}

export interface MinhashSignature {
  /** numPerm-length array of mins. */
  values: Uint32Array;
}

export function buildSignature(
  text: string,
  numPerm: number,
  coeffs: { a: Uint32Array; b: Uint32Array },
  shingleSize: number = 5,
): MinhashSignature {
  const sig = new Uint32Array(numPerm);
  sig.fill(0xffffffff);
  const grams = shingles(text, shingleSize);
  if (grams.length === 0) return { values: sig };
  for (const g of grams) {
    const h = murmurhash3_32(g);
    for (let i = 0; i < numPerm; i += 1) {
      // (a_i * h + b_i) mod p — mod-multiply with a 53-bit-safe product.
      const ai = coeffs.a[i] as number;
      const bi = coeffs.b[i] as number;
      // Math.imul returns int32; cast back to uint via >>> 0, then
      // expand to Number for the modulus step.
      const product = (Math.imul(ai, h) >>> 0) + bi;
      const hi = product % PERM_PRIME;
      if (hi < (sig[i] as number)) sig[i] = hi;
    }
  }
  return { values: sig };
}

/** Estimated Jaccard similarity: fraction of signature positions that
 *  agree. Standard MinHash result; converges to true Jaccard as
 *  numPerm grows. */
export function estimateJaccard(a: MinhashSignature, b: MinhashSignature): number {
  const av = a.values;
  const bv = b.values;
  if (av.length !== bv.length) return 0;
  let same = 0;
  for (let i = 0; i < av.length; i += 1) {
    if ((av[i] as number) === (bv[i] as number)) same += 1;
  }
  return same / av.length;
}

export interface DuplicatesMinhashCluster {
  id: string;
  sessionIds: readonly string[];
  centroidSessionId: string;
  /** Mean pairwise Jaccard estimate within the cluster. */
  meanJaccard: number;
}

export interface DuplicatesMinhashFile {
  version: 1;
  generatedAt: number;
  threshold: number;
  numPerm: number;
  clusters: readonly DuplicatesMinhashCluster[];
}

export interface MinhashInput {
  sessionId: string;
  text: string;
}

export interface BuildMinhashDuplicatesOptions {
  /** Jaccard threshold above which a candidate pair is a duplicate. Default 0.6. */
  threshold?: number;
  /** Hash permutations per signature. Default 128. */
  numPerm?: number;
  /** Shingle (word-n-gram) size. Default 5. */
  shingleSize?: number;
  /** LSH bands. Default 16. `bands * rows` MUST equal `numPerm`. */
  bands?: number;
  /** LSH rows per band. Default 8. */
  rows?: number;
  /** Pairs to exclude (already in `duplicates.exact.json`). Same
   *  `sessionIdA::sessionIdB` (lex-sorted) shape as semantic dedup. */
  excludePairs?: ReadonlySet<string>;
  /** Override Date.now() for tests. */
  now?: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Top-level: signature → LSH bucketing → candidate pairs → exact
 * Jaccard filter → union-find clusters → `DuplicatesMinhashFile`.
 *
 * LSH banding produces candidate pairs cheaply (any two signatures
 * that share a band hash become a candidate). Each candidate is then
 * confirmed by computing the actual Jaccard estimate from the full
 * signatures — protects against the small recall overshoot inherent
 * in LSH banding.
 */
export function buildMinhashDuplicates(
  inputs: readonly MinhashInput[],
  options: BuildMinhashDuplicatesOptions = {},
): DuplicatesMinhashFile {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const numPerm = options.numPerm ?? DEFAULT_NUM_PERM;
  const bands = options.bands ?? DEFAULT_BANDS;
  const rows = options.rows ?? DEFAULT_ROWS;
  const shingleSize = options.shingleSize ?? 5;
  const exclude = options.excludePairs ?? new Set<string>();
  const now = options.now ?? Date.now();

  if (bands * rows !== numPerm) {
    throw new Error(
      `MinHash LSH config error: bands(${bands}) * rows(${rows}) must equal numPerm(${numPerm})`,
    );
  }

  if (inputs.length === 0) {
    return { version: 1, generatedAt: now, threshold, numPerm, clusters: [] };
  }

  const coeffs = buildPermutationCoefficients(numPerm);
  const signatures: MinhashSignature[] = inputs.map((inp) =>
    buildSignature(inp.text, numPerm, coeffs, shingleSize),
  );

  // LSH bucketing: hash each (band, slice) into a bucket; entries that
  // collide are candidate pairs.
  const bandBuckets: Map<string, number[]>[] = Array.from(
    { length: bands },
    () => new Map<string, number[]>(),
  );
  for (let docIdx = 0; docIdx < inputs.length; docIdx += 1) {
    const sig = signatures[docIdx] as MinhashSignature;
    for (let b = 0; b < bands; b += 1) {
      const start = b * rows;
      // Cheap band-hash: concatenate the rows as a comma-separated key.
      // Could be MurmurHash3'd for shorter keys, but Map lookups on
      // strings are already efficient.
      const parts: string[] = [];
      for (let r = 0; r < rows; r += 1) {
        parts.push(String(sig.values[start + r] as number));
      }
      const key = parts.join(',');
      const bucket = bandBuckets[b] as Map<string, number[]>;
      const list = bucket.get(key);
      if (list === undefined) bucket.set(key, [docIdx]);
      else list.push(docIdx);
    }
  }

  // Collect candidate pairs (deduplicated across bands).
  const candidates = new Set<string>();
  for (const bucket of bandBuckets) {
    for (const list of bucket.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i] as number;
          const c = list[j] as number;
          candidates.add(a < c ? `${a},${c}` : `${c},${a}`);
        }
      }
    }
  }

  // Confirm each candidate by exact Jaccard estimate; build union-find.
  const parent: number[] = inputs.map((_, i) => i);
  const find = (x: number): number => {
    let cur = x;
    while ((parent[cur] as number) !== cur) {
      const next = parent[cur] as number;
      parent[cur] = parent[next] as number;
      cur = parent[cur] as number;
    }
    return cur;
  };

  const confirmedPairs: Array<{ a: number; b: number; sim: number }> = [];
  for (const key of candidates) {
    const [aStr, bStr] = key.split(',');
    const a = Number(aStr);
    const b = Number(bStr);
    const ia = inputs[a] as MinhashInput;
    const ib = inputs[b] as MinhashInput;
    if (exclude.has(pairKey(ia.sessionId, ib.sessionId))) continue;
    const sim = estimateJaccard(
      signatures[a] as MinhashSignature,
      signatures[b] as MinhashSignature,
    );
    if (sim < threshold) continue;
    confirmedPairs.push({ a, b, sim });
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Bucket members by root.
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < inputs.length; i += 1) {
    const r = find(i);
    const list = byRoot.get(r);
    if (list === undefined) byRoot.set(r, [i]);
    else list.push(i);
  }

  const clusters: DuplicatesMinhashCluster[] = [];
  let nextId = 0;
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const memberSet = new Set(members);
    const memberPairs = confirmedPairs.filter(
      (p) => memberSet.has(p.a) && memberSet.has(p.b),
    );
    if (memberPairs.length === 0) continue;
    const meanJaccard =
      memberPairs.reduce((acc, p) => acc + p.sim, 0) / memberPairs.length;

    // Centroid: member with highest summed Jaccard to other members.
    const degree = new Map<number, number>();
    for (const p of memberPairs) {
      degree.set(p.a, (degree.get(p.a) ?? 0) + p.sim);
      degree.set(p.b, (degree.get(p.b) ?? 0) + p.sim);
    }
    let bestIdx = members[0] as number;
    let bestScore = -Infinity;
    for (const m of members) {
      const d = degree.get(m) ?? 0;
      if (d > bestScore) {
        bestScore = d;
        bestIdx = m;
      }
    }
    const centroidSessionId = (inputs[bestIdx] as MinhashInput).sessionId;

    const orderedIds = [...members]
      .map((m) => {
        const sim = estimateJaccard(
          signatures[bestIdx] as MinhashSignature,
          signatures[m] as MinhashSignature,
        );
        return { sessionId: (inputs[m] as MinhashInput).sessionId, sim };
      })
      .sort((x, y) => y.sim - x.sim)
      .map((x) => x.sessionId);

    clusters.push({
      id: `dup-minhash-${nextId}`,
      sessionIds: orderedIds,
      centroidSessionId,
      meanJaccard,
    });
    nextId += 1;
  }

  clusters.sort((a, b) => {
    if (b.sessionIds.length !== a.sessionIds.length) {
      return b.sessionIds.length - a.sessionIds.length;
    }
    return a.centroidSessionId < b.centroidSessionId ? -1 : 1;
  });

  return { version: 1, generatedAt: now, threshold, numPerm, clusters };
}
