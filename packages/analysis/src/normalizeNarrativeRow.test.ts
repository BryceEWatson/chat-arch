import { describe, it, expect } from 'vitest';
import type { Narrative } from '@chat-arch/schema';
import {
  classifyAttribution,
  normalizeNarrativeRow,
} from './normalizeNarrativeRow.js';

function mkRow(overrides: Partial<Narrative> = {}): Narrative {
  return {
    id: 'narr_x',
    projectId: 'proj_x',
    sessionIds: ['s1', 's2'],
    sentiment: 'positive',
    title: 't',
    body: 'b',
    evidence: [],
    generatedAt: new Date(0).toISOString(),
    actionType: 'encode-as-pattern',
    schemaVersion: 1,
    ...overrides,
  };
}

describe('normalizeNarrativeRow', () => {
  it('defaults missing attributedTo to "deterministic"', () => {
    const row = mkRow();
    const norm = normalizeNarrativeRow(row);
    expect(norm.attributedTo).toBe('deterministic');
  });

  it('defaults missing contradictingCount to 0', () => {
    const row = mkRow();
    const norm = normalizeNarrativeRow(row);
    expect(norm.contradictingCount).toBe(0);
  });

  it('defaults missing verifiedAt to null', () => {
    const row = mkRow();
    const norm = normalizeNarrativeRow(row);
    expect(norm.verifiedAt).toBeNull();
  });

  it('passes populated fields through unchanged', () => {
    const row = mkRow({
      attributedTo: 'llm-derived',
      contradictingCount: 3,
      verifiedAt: '2026-01-01T00:00:00Z',
      schemaVersion: 2,
    });
    const norm = normalizeNarrativeRow(row);
    expect(norm.attributedTo).toBe('llm-derived');
    expect(norm.contradictingCount).toBe(3);
    expect(norm.verifiedAt).toBe('2026-01-01T00:00:00Z');
  });
});

describe('classifyAttribution', () => {
  it('buckets "deterministic" as heuristic', () => {
    expect(classifyAttribution(mkRow({ attributedTo: 'deterministic' }))).toBe(
      'heuristic',
    );
  });

  it('buckets "deterministic-with-prior" as heuristic', () => {
    expect(
      classifyAttribution(mkRow({ attributedTo: 'deterministic-with-prior' })),
    ).toBe('heuristic');
  });

  it('buckets "llm-derived" as llm', () => {
    expect(classifyAttribution(mkRow({ attributedTo: 'llm-derived' }))).toBe(
      'llm',
    );
  });

  it('buckets "falsifier-verified" as llm', () => {
    expect(
      classifyAttribution(mkRow({ attributedTo: 'falsifier-verified' })),
    ).toBe('llm');
  });

  it('returns "unknown" for legacy row missing attributedTo (caller must normalize first)', () => {
    // classifyAttribution does NOT default — pre-normalize via
    // normalizeNarrativeRow. Direct call on a missing field returns
    // 'unknown' so the caller is forced to be explicit.
    const row = mkRow();
    expect(classifyAttribution(row)).toBe('unknown');
    // Through the normalizer the same row buckets as heuristic.
    expect(classifyAttribution(normalizeNarrativeRow(row))).toBe('heuristic');
  });

  it('returns "unknown" for unrecognized future attribution value', () => {
    // Force an out-of-union value to simulate a future writer's
    // emission. Caller must drop with a log, NOT silently coerce.
    const row = mkRow({
      attributedTo: 'future-experimental-bucket' as unknown as never,
    });
    expect(classifyAttribution(row)).toBe('unknown');
  });
});
