#!/usr/bin/env node
/**
 * Stage 4 of the correction-mining pipeline: cluster classified
 * corrections, cross-check existing config sentences, emit
 * CorrectionPattern[]. The proposal LLM (Stage 5) fills proposedUpgrades
 * later — we leave it [] here.
 *
 * Cluster id stability: id = sha256(normalized canonical rule).slice(0,12).
 * Normalization is lowercase + collapse whitespace + strip trailing
 * punctuation. That absorbs casing/punctuation drift across runs but not
 * word-form drift ("don't" vs "do not"). Genuinely different distillations
 * → different ids by design (different rules should be different patterns).
 * The skill mitigates single-run classifier wobble by passing prior
 * canonical rules as anchors in the classification prompt — out of scope
 * here.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clusterByThreshold, sha256Hex } from '@chat-arch/analysis';
import type {
  ConfigsFile,
  Correction,
  CorrectionPattern,
  CorrectionsFile,
} from '@chat-arch/schema';
import { embed, cosineSimilarity, DEFAULT_EMBEDDING_MODEL } from '../embeddings/index.js';

interface ParsedArgs {
  classifications: string;
  configs: string;
  output: string;
  clusterThreshold: number;
  alreadyEncodedThreshold: number;
  minOccurrences: number;
  baseUrl?: string;
  model: string;
}

const USAGE = `\
cluster-corrections-cli
  --classifications <path>            CorrectionsFile JSON with classification populated
  --configs <path>                    ConfigsFile JSON
  --output <path>                     CorrectionPattern[] output JSON
  [--cluster-threshold <0..1>=0.65]
  [--already-encoded-threshold <0..1>=0.65]
  [--min-occurrences <N>=3]
  [--base-url <url>=http://localhost:11434]
  [--model <name>=mxbai-embed-large]
`;

function parseArgs(argv: string[]): ParsedArgs {
  let classifications: string | undefined;
  let configs: string | undefined;
  let output: string | undefined;
  // Calibrated against mxbai-embed-large on rule-similarity (8-text panel,
  // see _planning/correction-mining-demo/FINDINGS.md):
  //   - same-rule paraphrases: 0.657 - 0.807
  //   - distinct-rule pairs:   0.331 - 0.628
  // The 0.65 default sits in the [0.628, 0.657] gap. Single-linkage
  // chaining absorbs the borderline 0.657 case via transitivity. Tune via
  // flag for other embedding models or genuinely different rule distributions.
  let clusterThreshold = 0.65;
  let alreadyEncodedThreshold = 0.65;
  let minOccurrences = 3;
  let baseUrl: string | undefined;
  let model = DEFAULT_EMBEDDING_MODEL;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (next === undefined) break;
    if (a === '--classifications') {
      classifications = next;
      i += 1;
    } else if (a === '--configs') {
      configs = next;
      i += 1;
    } else if (a === '--output') {
      output = next;
      i += 1;
    } else if (a === '--cluster-threshold') {
      clusterThreshold = Number(next);
      i += 1;
    } else if (a === '--already-encoded-threshold') {
      alreadyEncodedThreshold = Number(next);
      i += 1;
    } else if (a === '--min-occurrences') {
      minOccurrences = Number(next);
      i += 1;
    } else if (a === '--base-url') {
      baseUrl = next;
      i += 1;
    } else if (a === '--model') {
      model = next;
      i += 1;
    }
  }

  if (!classifications || !configs || !output) {
    throw new Error(USAGE);
  }
  if (
    !Number.isFinite(clusterThreshold) ||
    clusterThreshold < 0 ||
    clusterThreshold > 1
  ) {
    throw new Error('--cluster-threshold must be a number in [0, 1]');
  }
  if (
    !Number.isFinite(alreadyEncodedThreshold) ||
    alreadyEncodedThreshold < 0 ||
    alreadyEncodedThreshold > 1
  ) {
    throw new Error('--already-encoded-threshold must be a number in [0, 1]');
  }
  if (!Number.isInteger(minOccurrences) || minOccurrences < 1) {
    throw new Error('--min-occurrences must be a positive integer');
  }

  return {
    classifications,
    configs,
    output,
    clusterThreshold,
    alreadyEncodedThreshold,
    minOccurrences,
    model,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

/**
 * Normalize a distilled rule for hashing. Lowercase, collapse whitespace,
 * strip trailing punctuation. Display text uses the un-normalized form.
 */
export function normalizeRule(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s.,;:!?]+$/u, '');
}

/** Reference back into a config document for an embedded sentence. */
export interface SentenceRef {
  configDocId: string;
  sentenceIndex: number;
}

export interface BuildPatternsOptions {
  clusterThreshold: number;
  alreadyEncodedThreshold: number;
  minOccurrences: number;
}

/**
 * Pure inner builder. Takes already-filtered corrections + their
 * embedded rule vectors + embedded config-sentence vectors, returns the
 * sorted CorrectionPattern[].
 *
 * `firstSeen`/`lastSeen` are 0 placeholders — we do not have turn
 * timestamps on the candidate. The skill or a later pass can backfill
 * from session metadata.
 */
export function buildPatterns(
  corrections: readonly Correction[],
  ruleVectors: readonly Float32Array[],
  sentenceVectors: readonly Float32Array[],
  _sentenceRefs: readonly SentenceRef[],
  opts: BuildPatternsOptions,
): CorrectionPattern[] {
  if (corrections.length === 0) return [];
  if (corrections.length !== ruleVectors.length) {
    throw new Error(
      `buildPatterns: corrections (${corrections.length}) and ruleVectors (${ruleVectors.length}) length mismatch`,
    );
  }

  const assignments = clusterByThreshold(ruleVectors, opts.clusterThreshold);
  const clusterCount = assignments.length === 0 ? 0 : Math.max(...assignments) + 1;

  const patterns: CorrectionPattern[] = [];
  for (let cid = 0; cid < clusterCount; cid += 1) {
    const memberIdx: number[] = [];
    for (let i = 0; i < assignments.length; i += 1) {
      if (assignments[i] === cid) memberIdx.push(i);
    }
    if (memberIdx.length === 0) continue;

    const members = memberIdx.map((i) => corrections[i] as Correction);
    const distinctSessions = new Set(members.map((m) => m.sessionId));
    if (distinctSessions.size < opts.minOccurrences) continue;

    // Pick canonical: highest classification confidence, tiebreak alphabetically
    // by distilledRule. We trust the caller to have filtered classification != null.
    const sorted = [...members].sort((a, b) => {
      const ca = a.classification!.confidence;
      const cb = b.classification!.confidence;
      if (cb !== ca) return cb - ca;
      return a.classification!.distilledRule.localeCompare(b.classification!.distilledRule);
    });
    const representative = sorted[0] as Correction;
    const displayRule = representative.classification!.distilledRule;
    const normalized = normalizeRule(displayRule);
    const id = `pat_${sha256Hex(normalized).slice(0, 12)}`;

    // Centroid of cluster member embeddings, re-normalized.
    const dim = (ruleVectors[memberIdx[0] as number] as Float32Array).length;
    const centroid = new Float32Array(dim);
    for (const i of memberIdx) {
      const v = ruleVectors[i] as Float32Array;
      for (let d = 0; d < dim; d += 1) {
        centroid[d] = (centroid[d] as number) + (v[d] as number);
      }
    }
    let sq = 0;
    for (let d = 0; d < dim; d += 1) {
      const mean = (centroid[d] as number) / memberIdx.length;
      centroid[d] = mean;
      sq += mean * mean;
    }
    const norm = Math.sqrt(sq);
    if (norm > 0) {
      for (let d = 0; d < dim; d += 1) {
        centroid[d] = (centroid[d] as number) / norm;
      }
    }

    let maxConfigSim = 0;
    for (const sv of sentenceVectors) {
      const s = cosineSimilarity(centroid, sv);
      if (s > maxConfigSim) maxConfigSim = s;
    }
    const alreadyEncoded = maxConfigSim >= opts.alreadyEncodedThreshold;

    const meanConfidence =
      members.reduce((acc, m) => acc + m.classification!.confidence, 0) / members.length;
    const occurrenceCount = distinctSessions.size;
    let confidence = meanConfidence * Math.min(1, occurrenceCount / 5);
    if (alreadyEncoded) confidence *= 0.9;

    patterns.push({
      id,
      canonicalRule: displayRule,
      instanceIds: members.map((m) => m.id),
      occurrenceCount,
      firstSeen: 0,
      lastSeen: 0,
      scope: { kind: 'global' },
      proposedUpgrades: [],
      confidence,
      recurringPostApplication: false,
      alreadyEncoded,
    });
  }

  patterns.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.occurrenceCount - a.occurrenceCount;
  });
  return patterns;
}

/** Filter corrections to actionable, classified, ≥0.5 confidence. */
export function filterClassified(corrections: readonly Correction[]): Correction[] {
  return corrections.filter(
    (c) =>
      c.classification !== null &&
      c.classification.actionable === true &&
      c.classification.confidence >= 0.5,
  );
}

interface OutputFile {
  generatedAt: number;
  patterns: readonly CorrectionPattern[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const classificationsRaw = await readFile(args.classifications, 'utf8');
  const classificationsFile = JSON.parse(classificationsRaw) as CorrectionsFile;
  if (!Array.isArray(classificationsFile.corrections)) {
    throw new Error('--classifications: missing corrections[] array');
  }

  const filtered = filterClassified(classificationsFile.corrections);

  if (filtered.length === 0) {
    const out: OutputFile = { generatedAt: Date.now(), patterns: [] };
    await mkdir(path.dirname(args.output), { recursive: true });
    await writeFile(args.output, JSON.stringify(out, null, 2) + '\n', 'utf8');
    return;
  }

  const ruleTexts = filtered.map((c) => c.classification!.distilledRule);
  const embedOpts: { model: string; baseUrl?: string } = { model: args.model };
  if (args.baseUrl !== undefined) embedOpts.baseUrl = args.baseUrl;
  const ruleVectors = await embed(ruleTexts, embedOpts);

  const configsRaw = await readFile(args.configs, 'utf8');
  const configsFile = JSON.parse(configsRaw) as ConfigsFile;
  const sentenceTexts: string[] = [];
  const sentenceRefs: SentenceRef[] = [];
  for (const doc of configsFile.documents ?? []) {
    for (const sentence of doc.sentences) {
      sentenceTexts.push(sentence.text);
      sentenceRefs.push({ configDocId: doc.id, sentenceIndex: sentence.index });
    }
  }
  const sentenceVectors =
    sentenceTexts.length === 0 ? [] : await embed(sentenceTexts, embedOpts);

  const patterns = buildPatterns(filtered, ruleVectors, sentenceVectors, sentenceRefs, {
    clusterThreshold: args.clusterThreshold,
    alreadyEncodedThreshold: args.alreadyEncodedThreshold,
    minOccurrences: args.minOccurrences,
  });

  const out: OutputFile = { generatedAt: Date.now(), patterns };
  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cluster-corrections-cli: ${msg}\n`);
    process.exit(1);
  });
}
