import { describe, it, expect } from 'vitest';
import { assertManifestShape } from './fetch.js';

describe('assertManifestShape (R12 F12.1)', () => {
  it('accepts a well-formed empty manifest (valid UC-8 empty state, not an error)', () => {
    const m = { schemaVersion: 1, generatedAt: 0, counts: {}, sessions: [] };
    expect(() => assertManifestShape(m)).not.toThrow();
  });

  it('accepts a well-formed populated manifest', () => {
    const m = {
      schemaVersion: 1,
      generatedAt: 0,
      counts: { cloud: 1, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
      sessions: [{ id: 'abc', source: 'cloud', rawSessionId: 'abc', startedAt: 0, updatedAt: 0 }],
    };
    expect(() => assertManifestShape(m)).not.toThrow();
  });

  it('throws on a bare array (the F12.1 repro: `manifest.json = "[]"`)', () => {
    expect(() => assertManifestShape([])).toThrowError(/sessions/);
  });

  it('throws on a non-object payload', () => {
    expect(() => assertManifestShape('garbage')).toThrowError(/JSON object/);
    expect(() => assertManifestShape(null)).toThrowError(/JSON object/);
  });

  it('throws when counts is missing', () => {
    expect(() => assertManifestShape({ schemaVersion: 1, sessions: [] })).toThrowError(/counts/);
  });

  it('throws when a session entry lacks id/source', () => {
    expect(() =>
      assertManifestShape({
        schemaVersion: 1,
        counts: {},
        sessions: [{ notAnId: 'oops' }],
      }),
    ).toThrowError(/id\/source/);
  });
});
