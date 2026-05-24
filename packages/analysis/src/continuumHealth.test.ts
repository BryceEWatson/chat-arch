import { describe, it, expect } from 'vitest';
import type {
  ContinuumHealth,
  SessionManifest,
  SessionSource,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { buildContinuumHealth } from './continuumHealth.js';

function s(
  id: string,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cowork',
    rawSessionId: id,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    durationMs: 1000,
    title: id,
    titleSource: 'fallback',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  };
}

function manifestOf(sessions: UnifiedSessionEntry[]): SessionManifest {
  const counts: Record<SessionSource, number> = {
    cloud: 0,
    cowork: 0,
    'cli-direct': 0,
    'cli-desktop': 0,
  };
  for (const e of sessions) counts[e.source] += 1;
  return {
    schemaVersion: 4,
    generatedAt: 1_700_000_002_000,
    counts,
    sessions,
  };
}

const NOW = Date.parse('2026-05-16T03:00:12.000Z');

describe('buildContinuumHealth', () => {
  it('first scan with success starts the streak at 1 and counts all sessions as new', () => {
    const m = manifestOf([
      s('a', { source: 'cowork' }),
      s('b', { source: 'cli-direct' }),
      s('c', { source: 'cloud' }),
    ]);
    const r = buildContinuumHealth(m, null, { now: NOW, scanSucceeded: true });
    expect(r.version).toBe(1);
    expect(r.lastScanAt).toBe('2026-05-16T03:00:12.000Z');
    expect(r.lastSuccessfulScanAt).toBe('2026-05-16T03:00:12.000Z');
    expect(r.consecutiveSuccesses).toBe(1);
    expect(r.newSessionsSinceLast).toBe(3);
    expect(r.warnings).toEqual([]);
  });

  it('increments consecutiveSuccesses on success after success', () => {
    const prior: ContinuumHealth = {
      version: 1,
      lastScanAt: '2026-05-15T03:00:00.000Z',
      lastSuccessfulScanAt: '2026-05-15T03:00:00.000Z',
      consecutiveSuccesses: 13,
      sourcesScanned: ['cowork'],
      entriesByStatus: { ok: 1, missing: 0, crashed: 0, pruned: 0 },
      newSessionsSinceLast: 0,
      warnings: [],
    };
    const m = manifestOf([s('a', { startedAt: Date.parse('2026-05-15T12:00:00Z') })]);
    const r = buildContinuumHealth(m, prior, { now: NOW, scanSucceeded: true });
    expect(r.consecutiveSuccesses).toBe(14);
    expect(r.lastSuccessfulScanAt).toBe('2026-05-16T03:00:12.000Z');
  });

  it('on failure resets consecutiveSuccesses but preserves lastSuccessfulScanAt', () => {
    const prior: ContinuumHealth = {
      version: 1,
      lastScanAt: '2026-05-15T03:00:00.000Z',
      lastSuccessfulScanAt: '2026-05-15T03:00:00.000Z',
      consecutiveSuccesses: 7,
      sourcesScanned: ['cowork'],
      entriesByStatus: { ok: 1, missing: 0, crashed: 0, pruned: 0 },
      newSessionsSinceLast: 0,
      warnings: [],
    };
    const m = manifestOf([s('a')]);
    const r = buildContinuumHealth(m, prior, { now: NOW, scanSucceeded: false });
    expect(r.consecutiveSuccesses).toBe(0);
    expect(r.lastSuccessfulScanAt).toBe('2026-05-15T03:00:00.000Z');
    expect(r.lastScanAt).toBe('2026-05-16T03:00:12.000Z');
  });

  it('emits a missing-rate-high warning when ratio exceeds threshold', () => {
    const sessions: UnifiedSessionEntry[] = [];
    for (let i = 0; i < 7; i += 1) {
      sessions.push(s(`ok-${i}`, { source: 'cli-desktop', transcriptStatus: 'ok' }));
    }
    for (let i = 0; i < 3; i += 1) {
      sessions.push(s(`miss-${i}`, { source: 'cli-desktop', transcriptStatus: 'missing' }));
    }
    const r = buildContinuumHealth(manifestOf(sessions), null, {
      now: NOW,
      scanSucceeded: true,
    });
    const warn = r.warnings.find((w) => w.kind === 'missing-rate-high');
    expect(warn).toBeDefined();
    expect(warn!.source).toBe('cli-desktop');
    expect(warn!.value).toBeCloseTo(0.3, 10);
    expect(warn!.threshold).toBe(0.2);
  });

  it('emits a crashed-count-high warning when crashed count exceeds threshold', () => {
    const sessions: UnifiedSessionEntry[] = [];
    for (let i = 0; i < 6; i += 1) {
      sessions.push(s(`c-${i}`, { source: 'cowork', transcriptStatus: 'crashed' }));
    }
    const r = buildContinuumHealth(manifestOf(sessions), null, {
      now: NOW,
      scanSucceeded: true,
    });
    const warn = r.warnings.find((w) => w.kind === 'crashed-count-high');
    expect(warn).toBeDefined();
    expect(warn!.source).toBe('cowork');
    expect(warn!.value).toBe(6);
    expect(warn!.threshold).toBe(5);
  });

  it('emits sourcesScanned in canonical order regardless of input order', () => {
    const m = manifestOf([
      s('a', { source: 'cloud' }),
      s('b', { source: 'cli-desktop' }),
      s('c', { source: 'cowork' }),
      s('d', { source: 'cli-direct' }),
    ]);
    const r = buildContinuumHealth(m, null, { now: NOW, scanSucceeded: true });
    expect(r.sourcesScanned).toEqual([
      'cowork',
      'cli-direct',
      'cli-desktop',
      'cloud',
    ]);
  });

  it('emits all four entriesByStatus keys with zeros when absent', () => {
    const m = manifestOf([s('a', { transcriptStatus: 'ok' })]);
    const r = buildContinuumHealth(m, null, { now: NOW, scanSucceeded: true });
    expect(r.entriesByStatus).toEqual({
      ok: 1,
      missing: 0,
      crashed: 0,
      pruned: 0,
    });
  });

  it('treats undefined transcriptStatus as ok', () => {
    const m = manifestOf([s('a'), s('b'), s('c', { transcriptStatus: 'missing' })]);
    const r = buildContinuumHealth(m, null, { now: NOW, scanSucceeded: true });
    expect(r.entriesByStatus.ok).toBe(2);
    expect(r.entriesByStatus.missing).toBe(1);
  });

  it('counts newSessionsSinceLast as those started after the prior success', () => {
    const prior: ContinuumHealth = {
      version: 1,
      lastScanAt: '2026-05-15T03:00:00.000Z',
      lastSuccessfulScanAt: '2026-05-15T03:00:00.000Z',
      consecutiveSuccesses: 1,
      sourcesScanned: ['cowork'],
      entriesByStatus: { ok: 0, missing: 0, crashed: 0, pruned: 0 },
      newSessionsSinceLast: 0,
      warnings: [],
    };
    const cutoff = Date.parse('2026-05-15T03:00:00.000Z');
    const m = manifestOf([
      s('old', { startedAt: cutoff - 1000 }),
      s('new-1', { startedAt: cutoff + 1000 }),
      s('new-2', { startedAt: cutoff + 2000 }),
    ]);
    const r = buildContinuumHealth(m, prior, { now: NOW, scanSucceeded: true });
    expect(r.newSessionsSinceLast).toBe(2);
  });

  it('sorts warnings by source then kind', () => {
    const sessions: UnifiedSessionEntry[] = [];
    // cli-desktop: 10 entries, 3 missing → missing-rate-high
    for (let i = 0; i < 7; i += 1) {
      sessions.push(s(`d-ok-${i}`, { source: 'cli-desktop', transcriptStatus: 'ok' }));
    }
    for (let i = 0; i < 3; i += 1) {
      sessions.push(s(`d-m-${i}`, { source: 'cli-desktop', transcriptStatus: 'missing' }));
    }
    // cowork: 6 crashed → crashed-count-high AND missing-rate-high (6/6 missing? no — crashed)
    for (let i = 0; i < 6; i += 1) {
      sessions.push(s(`c-${i}`, { source: 'cowork', transcriptStatus: 'crashed' }));
    }
    const r = buildContinuumHealth(manifestOf(sessions), null, {
      now: NOW,
      scanSucceeded: true,
    });
    // cowork comes before cli-desktop in canonical order.
    expect(r.warnings[0]?.source).toBe('cowork');
    expect(r.warnings[r.warnings.length - 1]?.source).toBe('cli-desktop');
  });
});
