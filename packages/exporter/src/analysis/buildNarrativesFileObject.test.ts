import { describe, it, expect, vi } from 'vitest';
import type {
  Narrative,
  NarrativeThresholdsSnapshot,
  SkippedRow,
} from '@chat-arch/schema';
import { buildNarrativesFileObject } from './buildNarrativesFileObject.js';

function mkRow(id: string): Narrative {
  return {
    id,
    projectId: 'proj_x',
    sessionIds: ['s1'],
    sentiment: 'positive',
    title: id,
    body: 'b',
    evidence: [],
    generatedAt: new Date(0).toISOString(),
    actionType: 'encode-as-pattern',
    schemaVersion: 1,
    attributedTo: 'deterministic',
  };
}

const THRESHOLDS_SNAPSHOT: NarrativeThresholdsSnapshot = {
  minSessionsForLlm: 20,
  maxSessionsForCorpus: 200,
  minPerProject: 3,
  maxPerProject: 8,
  evidenceMinPerNarrative: 2,
  maxLlmUsdPerProject: 0.5,
};

describe('buildNarrativesFileObject', () => {
  it('emits all known fields in the expected shape', () => {
    const skipped: SkippedRow[] = [
      { projectId: 'proj_y', status: 'insufficient-corpus', reason: '9 < 20' },
    ];
    const file = buildNarrativesFileObject({
      generatedAt: 1716673200000,
      exporterVersion: '1.7.0',
      thresholds: THRESHOLDS_SNAPSHOT,
      narratives: [mkRow('a')],
      skipped,
    });
    expect(file.generatedAt).toBe(1716673200000);
    expect(file.exporterVersion).toBe('1.7.0');
    expect(file.thresholds).toEqual(THRESHOLDS_SNAPSHOT);
    expect(file.narratives).toHaveLength(1);
    expect(file.skipped).toEqual(skipped);
  });

  it('passes through unknown top-level keys', () => {
    const file = buildNarrativesFileObject(
      {
        generatedAt: 0,
        exporterVersion: '1.7.0',
        thresholds: THRESHOLDS_SNAPSHOT,
        narratives: [],
        skipped: [],
      },
      { futureField: 'v2-only', anotherFutureKey: { nested: true } },
    );
    expect((file as unknown as Record<string, unknown>)['futureField']).toBe(
      'v2-only',
    );
    expect(
      (file as unknown as Record<string, unknown>)['anotherFutureKey'],
    ).toEqual({ nested: true });
  });

  it('drops reserved keys from passthrough with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const file = buildNarrativesFileObject(
        {
          generatedAt: 1,
          exporterVersion: '1.7.0',
          thresholds: THRESHOLDS_SNAPSHOT,
          narratives: [mkRow('keep')],
          skipped: [],
        },
        {
          generatedAt: 999, // RESERVED — should be dropped with warn
          narratives: [mkRow('attacker-tries-to-overwrite')],
          okExtra: 'ok',
        },
      );
      expect(file.generatedAt).toBe(1);
      expect(file.narratives).toHaveLength(1);
      expect(file.narratives[0]?.id).toBe('keep');
      expect((file as unknown as Record<string, unknown>)['okExtra']).toBe('ok');
      // Two reserved-key warnings: generatedAt + narratives.
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('drops JS prototype-related keys (__proto__ / constructor / prototype) from passthrough with warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // `JSON.parse('{"__proto__": {...}}')` lands `__proto__` as an
      // own property on the resulting object — the on-disk attack
      // vector this defense guards against. A JS object literal
      // `{ __proto__: ... }` would SET the prototype instead (not
      // create an own property), so use JSON.parse to model the
      // attacker payload accurately.
      const adversarialPassthrough = JSON.parse(
        '{"__proto__": {"polluted": true}, "constructor": {"polluted": true}, "prototype": {"polluted": true}, "okExtra": "ok"}',
      ) as Record<string, unknown>;
      const file = buildNarrativesFileObject(
        {
          generatedAt: 0,
          exporterVersion: '1.7.0',
          thresholds: THRESHOLDS_SNAPSHOT,
          narratives: [],
          skipped: [],
        },
        adversarialPassthrough,
      );
      // The okExtra non-proto key still round-trips.
      expect((file as unknown as Record<string, unknown>)['okExtra']).toBe('ok');
      // None of the proto keys end up as own properties of the result.
      expect(
        Object.prototype.hasOwnProperty.call(file, '__proto__'),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(file, 'constructor'),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(file, 'prototype'),
      ).toBe(false);
      // Three proto-related drops + zero other warnings.
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('handles empty narratives and skipped arrays', () => {
    const file = buildNarrativesFileObject({
      generatedAt: 0,
      exporterVersion: '1.7.0',
      thresholds: THRESHOLDS_SNAPSHOT,
      narratives: [],
      skipped: [],
    });
    expect(file.narratives).toEqual([]);
    expect(file.skipped).toEqual([]);
  });
});
