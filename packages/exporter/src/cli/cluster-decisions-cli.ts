#!/usr/bin/env node
/**
 * Clustering stage of the decision-mining pipeline: cluster classified
 * decisions by semantic similarity of their `distilledDecision` text and
 * emit a `DecisionClustersFile` (recurring decisions — the same call made
 * across multiple sessions). Sibling of `cluster-corrections-cli.ts`;
 * reuses the same `clusterByThreshold` single-linkage kernel + `embed`
 * embedding helper, so a recurring decision surfaces the way a recurring
 * correction pattern does.
 *
 * Cluster id stability: id = `dpat_` + sha256(normalized canonical).slice(12).
 * Normalization = lowercase + collapse whitespace + strip trailing
 * punctuation. Same drift-absorption tradeoff as the corrections CLI.
 *
 * Unlike corrections clustering there is no config cross-check
 * (`alreadyEncoded`) — decisions aren't matched against the user's
 * CLAUDE.md. The extra signal we DO carry is `landedRate`: the share of
 * cluster members whose joined outcome was 'good'.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clusterByThreshold, sha256Hex, THRESHOLDS } from '@chat-arch/analysis';
import type { DecisionClustersFile, DecisionPattern } from '@chat-arch/schema';
import { embed, DEFAULT_EMBEDDING_MODEL } from '../embeddings/index.js';

/** One classified decision the skill hands to the clusterer. */
export interface ClassifiedDecisionInput {
  id: string;
  distilledDecision: string;
  sessionId: string;
  /** Joined outcome bucket, or null when the decision has no outcomeRef. */
  binaryClass: 'good' | 'bad' | 'neutral' | null;
  /** Session updatedAt (ms) when known; used for firstSeen/lastSeen. */
  updatedAt?: number;
}

interface ParsedArgs {
  classified: string;
  output: string;
  clusterThreshold: number;
  minOccurrences: number;
  /** Min non-neutral members before a `landedRate` is reported (else null). */
  landedRateMinN: number;
  baseUrl?: string;
  model: string;
}

const USAGE = `\
cluster-decisions-cli
  --classified <path>                 JSON { decisions: ClassifiedDecisionInput[] }
  --output <path>                     DecisionClustersFile JSON
  [--cluster-threshold <0..1>=0.65]
  [--min-occurrences <N>=2]           distinct sessions for a cluster to count
  [--landed-rate-min-n <N>]           default = THRESHOLDS.display.minNForRate
  [--base-url <url>=http://localhost:11434]
  [--model <name>=mxbai-embed-large]
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let classified: string | undefined;
  let output: string | undefined;
  // 0.65 mirrors the corrections clusterer — calibrated against
  // mxbai-embed-large on *rule* similarity. Decision `distilledDecision`
  // text is a different distribution; this is a deliberate extrapolation
  // pending decision-specific calibration. Tune via flag.
  let clusterThreshold = 0.65;
  // A recurring decision needs >=2 distinct sessions — a one-session
  // cluster isn't "recurring". (Corrections uses 3; decisions are rarer
  // per session, so 2 is the floor for cluster EXISTENCE.)
  let minOccurrences = 2;
  // Floor for reporting a landed-RATE — distinct from cluster existence.
  // Pinned to the same display floor the viewer uses for per-kind rates
  // (THRESHOLDS.display.minNForRate, derived so the Wilson 95% CI is
  // narrow enough to be informative). A bare "landed 100%" over 2 samples
  // is exactly the misleading-precision this floor prevents, so the rate
  // is null below it and the UI shows nothing.
  let landedRateMinN: number = THRESHOLDS.display.minNForRate;
  let baseUrl: string | undefined;
  let model = DEFAULT_EMBEDDING_MODEL;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (next === undefined) break;
    if (a === '--classified') {
      classified = next;
      i += 1;
    } else if (a === '--output') {
      output = next;
      i += 1;
    } else if (a === '--cluster-threshold') {
      clusterThreshold = Number(next);
      i += 1;
    } else if (a === '--min-occurrences') {
      minOccurrences = Number(next);
      i += 1;
    } else if (a === '--landed-rate-min-n') {
      landedRateMinN = Number(next);
      i += 1;
    } else if (a === '--base-url') {
      baseUrl = next;
      i += 1;
    } else if (a === '--model') {
      model = next;
      i += 1;
    }
  }

  if (!classified || !output) throw new Error(USAGE);
  if (!Number.isFinite(clusterThreshold) || clusterThreshold < 0 || clusterThreshold > 1) {
    throw new Error('--cluster-threshold must be a number in [0, 1]');
  }
  if (!Number.isInteger(minOccurrences) || minOccurrences < 1) {
    throw new Error('--min-occurrences must be a positive integer');
  }
  if (!Number.isInteger(landedRateMinN) || landedRateMinN < 1) {
    throw new Error('--landed-rate-min-n must be a positive integer');
  }

  return {
    classified,
    output,
    clusterThreshold,
    minOccurrences,
    landedRateMinN,
    model,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

/** Lowercase, collapse whitespace, strip trailing punctuation (for hashing). */
export function normalizeDecision(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s.,;:!?]+$/u, '');
}

export interface BuildDecisionClustersOptions {
  clusterThreshold: number;
  minOccurrences: number;
  landedRateMinN: number;
}

/**
 * Pure inner builder. Takes the classified decisions + their embedded
 * `distilledDecision` vectors (index-aligned), returns sorted
 * `DecisionPattern[]`. Exposed for unit testing without Ollama.
 */
export function buildDecisionClusters(
  decisions: readonly ClassifiedDecisionInput[],
  vectors: readonly Float32Array[],
  opts: BuildDecisionClustersOptions,
): DecisionPattern[] {
  if (decisions.length === 0) return [];
  if (decisions.length !== vectors.length) {
    throw new Error(
      `buildDecisionClusters: decisions (${decisions.length}) and vectors (${vectors.length}) length mismatch`,
    );
  }

  const assignments = clusterByThreshold(vectors, opts.clusterThreshold);
  const clusterCount = assignments.length === 0 ? 0 : Math.max(...assignments) + 1;

  const patterns: DecisionPattern[] = [];
  for (let cid = 0; cid < clusterCount; cid += 1) {
    const memberIdx: number[] = [];
    for (let i = 0; i < assignments.length; i += 1) {
      if (assignments[i] === cid) memberIdx.push(i);
    }
    if (memberIdx.length === 0) continue;

    const members = memberIdx.map((i) => decisions[i] as ClassifiedDecisionInput);
    const distinctSessions = new Set(members.map((m) => m.sessionId));
    if (distinctSessions.size < opts.minOccurrences) continue;

    // Canonical = alphabetically-first distilled text — deterministic and
    // stable across runs (no confidence field on the cluster input).
    const canonicalDecision = [...members]
      .map((m) => m.distilledDecision)
      .sort((a, b) => a.localeCompare(b))[0] as string;
    const id = `dpat_${sha256Hex(normalizeDecision(canonicalDecision)).slice(0, 12)}`;

    // landedRate over members with a non-neutral joined outcome.
    const decided = members.filter(
      (m) => m.binaryClass === 'good' || m.binaryClass === 'bad',
    );
    const landed = decided.filter((m) => m.binaryClass === 'good').length;
    const landedRate =
      decided.length >= opts.landedRateMinN ? landed / decided.length : null;
    const landedDenom = decided.length;

    // firstSeen/lastSeen from updatedAt where known, else 0 (placeholder,
    // same convention as the corrections clusterer).
    const stamps = members
      .map((m) => m.updatedAt)
      .filter((t): t is number => typeof t === 'number');
    const firstSeen = stamps.length > 0 ? Math.min(...stamps) : 0;
    const lastSeen = stamps.length > 0 ? Math.max(...stamps) : 0;

    patterns.push({
      id,
      canonicalDecision,
      instanceIds: members.map((m) => m.id),
      occurrenceCount: distinctSessions.size,
      firstSeen,
      lastSeen,
      landedRate,
      landedDenom,
    });
  }

  // Most-recurring first; tiebreak by landedRate desc (nulls last), then id.
  patterns.sort((a, b) => {
    if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
    const ra = a.landedRate ?? -1;
    const rb = b.landedRate ?? -1;
    if (rb !== ra) return rb - ra;
    return a.id.localeCompare(b.id);
  });
  return patterns;
}

interface ClassifiedFile {
  decisions?: readonly ClassifiedDecisionInput[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = await readFile(args.classified, 'utf8');
  const parsed = JSON.parse(raw) as ClassifiedFile;
  const decisions = (parsed.decisions ?? []).filter(
    (d) => typeof d.distilledDecision === 'string' && d.distilledDecision.trim().length > 0,
  );

  let patterns: DecisionPattern[] = [];
  if (decisions.length > 0) {
    const texts = decisions.map((d) => d.distilledDecision);
    const embedOpts: { model: string; baseUrl?: string } = { model: args.model };
    if (args.baseUrl !== undefined) embedOpts.baseUrl = args.baseUrl;
    const vectors = await embed(texts, embedOpts);
    patterns = buildDecisionClusters(decisions, vectors, {
      clusterThreshold: args.clusterThreshold,
      minOccurrences: args.minOccurrences,
      landedRateMinN: args.landedRateMinN,
    });
  }

  const out: DecisionClustersFile = { generatedAt: Date.now(), clusters: patterns };
  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cluster-decisions-cli: ${msg}\n`);
    process.exit(1);
  });
}
