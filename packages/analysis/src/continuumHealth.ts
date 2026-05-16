/**
 * Continuum-health writer — spec §5 Layer B (B.1 + B.2).
 *
 * Browser-safe pure function. Given the merged manifest and the prior
 * `continuum-health.json` (if any), emits a fresh `ContinuumHealth` record
 * capturing per-status counts, per-source capture-rate warnings, and the
 * "consecutive successful scans" streak that drives the viewer footer +
 * the daily brief's "Continuum health" section.
 *
 * Pure. No I/O, no `Date.now()` — caller supplies `options.now` so tests
 * stay deterministic and so the orchestrator can use a single shared
 * timestamp across every sidecar of a run.
 */

import type {
  ContinuumHealth,
  ContinuumWarning,
  ContinuumWarningKind,
  SessionManifest,
  SessionSource,
} from '@chat-arch/schema';

export interface BuildContinuumHealthOptions {
  /** Timestamp (ms) for `lastScanAt` and the success-flag tie-in. */
  now: number;
  /** Did the scan that produced this manifest complete without error? */
  scanSucceeded: boolean;
  thresholds?: {
    /** Per-source missing-rate ceiling. Default 0.20. */
    missingRatePerSource?: number;
    /** Per-source crashed-count ceiling. Default 5. */
    crashedCountPerSource?: number;
  };
}

const DEFAULT_MISSING_RATE = 0.2;
const DEFAULT_CRASHED_COUNT = 5;

/**
 * Canonical source-list order (matches the rest of the codebase + the
 * settled order in the spec). `sourcesScanned` emits the subset of these
 * actually present in the manifest, preserving this order so the value
 * is deterministic across runs.
 */
const CANONICAL_SOURCE_ORDER: readonly SessionSource[] = [
  'cowork',
  'cli-direct',
  'cli-desktop',
  'cloud',
] as const;

/** Stable warning-kind ordering for tie-breaks within a single source. */
const WARNING_KIND_ORDER: readonly ContinuumWarningKind[] = [
  'missing-rate-high',
  'crashed-count-high',
] as const;

export function buildContinuumHealth(
  manifest: SessionManifest,
  prior: ContinuumHealth | null,
  options: BuildContinuumHealthOptions,
): ContinuumHealth {
  const missingThreshold =
    options.thresholds?.missingRatePerSource ?? DEFAULT_MISSING_RATE;
  const crashedThreshold =
    options.thresholds?.crashedCountPerSource ?? DEFAULT_CRASHED_COUNT;

  const lastScanAt = new Date(options.now).toISOString();
  const lastSuccessfulScanAt = options.scanSucceeded
    ? lastScanAt
    : prior?.lastSuccessfulScanAt ?? null;
  const consecutiveSuccesses = options.scanSucceeded
    ? (prior?.consecutiveSuccesses ?? 0) + 1
    : 0;

  // ---- sourcesScanned (canonical order, only those present) ----
  const presentSources = new Set<SessionSource>();
  for (const entry of manifest.sessions) {
    presentSources.add(entry.source);
  }
  const sourcesScanned: SessionSource[] = CANONICAL_SOURCE_ORDER.filter((s) =>
    presentSources.has(s),
  );

  // ---- entriesByStatus (always emit all four keys) ----
  const entriesByStatus = { ok: 0, missing: 0, crashed: 0, pruned: 0 };
  for (const entry of manifest.sessions) {
    const status = entry.transcriptStatus ?? 'ok';
    entriesByStatus[status] += 1;
  }

  // ---- newSessionsSinceLast ----
  let newSessionsSinceLast: number;
  const priorMs =
    prior?.lastSuccessfulScanAt !== undefined &&
    prior?.lastSuccessfulScanAt !== null
      ? Date.parse(prior.lastSuccessfulScanAt)
      : null;
  if (priorMs === null || Number.isNaN(priorMs)) {
    newSessionsSinceLast = manifest.sessions.length;
  } else {
    let count = 0;
    for (const entry of manifest.sessions) {
      if (entry.startedAt > priorMs) count += 1;
    }
    newSessionsSinceLast = count;
  }

  // ---- per-source warnings ----
  const totalsBySource = new Map<SessionSource, number>();
  const missingBySource = new Map<SessionSource, number>();
  const crashedBySource = new Map<SessionSource, number>();
  for (const entry of manifest.sessions) {
    const src = entry.source;
    totalsBySource.set(src, (totalsBySource.get(src) ?? 0) + 1);
    const status = entry.transcriptStatus ?? 'ok';
    if (status === 'missing') {
      missingBySource.set(src, (missingBySource.get(src) ?? 0) + 1);
    } else if (status === 'crashed') {
      crashedBySource.set(src, (crashedBySource.get(src) ?? 0) + 1);
    }
  }

  const warnings: ContinuumWarning[] = [];
  for (const src of sourcesScanned) {
    const total = totalsBySource.get(src) ?? 0;
    if (total === 0) continue;
    const missingCount = missingBySource.get(src) ?? 0;
    const crashedCount = crashedBySource.get(src) ?? 0;
    const missingRate = missingCount / total;
    if (missingRate > missingThreshold) {
      warnings.push({
        source: src,
        kind: 'missing-rate-high',
        value: missingRate,
        threshold: missingThreshold,
      });
    }
    if (crashedCount > crashedThreshold) {
      warnings.push({
        source: src,
        kind: 'crashed-count-high',
        value: crashedCount,
        threshold: crashedThreshold,
      });
    }
  }
  warnings.sort((a, b) => {
    const sa = CANONICAL_SOURCE_ORDER.indexOf(a.source);
    const sb = CANONICAL_SOURCE_ORDER.indexOf(b.source);
    if (sa !== sb) return sa - sb;
    return (
      WARNING_KIND_ORDER.indexOf(a.kind) - WARNING_KIND_ORDER.indexOf(b.kind)
    );
  });

  return {
    version: 1,
    lastScanAt,
    lastSuccessfulScanAt,
    consecutiveSuccesses,
    sourcesScanned,
    entriesByStatus,
    newSessionsSinceLast,
    warnings,
  };
}
