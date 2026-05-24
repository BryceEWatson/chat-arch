/**
 * Wave 7 P2 #9 — pure-function tests for the knowledge-debt-state endpoint.
 *
 * Exercises:
 *   - validateStateBody — accepts valid bodies, rejects malformed ones
 *   - upsertState — inserts on new id, replaces in place on update
 */
import { describe, expect, it } from 'vitest';
import {
  upsertState,
  validateStateBody,
  type KnowledgeDebtStatesFile,
} from '../../src/pages/api/knowledge-debt-state.js';

describe('validateStateBody', () => {
  it('accepts a valid INSTALLED body', () => {
    const r = validateStateBody({
      clusterId: 'k1',
      state: 'INSTALLED',
      sizeAtState: 12,
    });
    expect('error' in r).toBe(false);
  });

  it('accepts PENDING and DISMISSED', () => {
    for (const state of ['PENDING', 'DISMISSED']) {
      const r = validateStateBody({
        clusterId: 'k1',
        state,
        sizeAtState: 1,
      });
      expect('error' in r).toBe(false);
    }
  });

  it('rejects unknown states', () => {
    const r = validateStateBody({
      clusterId: 'k1',
      state: 'bogus',
      sizeAtState: 1,
    });
    expect('error' in r).toBe(true);
  });

  it('rejects missing clusterId', () => {
    const r = validateStateBody({ state: 'INSTALLED', sizeAtState: 1 });
    expect('error' in r).toBe(true);
  });

  it('rejects non-finite sizeAtState', () => {
    const r = validateStateBody({
      clusterId: 'x',
      state: 'PENDING',
      sizeAtState: 'huge',
    });
    expect('error' in r).toBe(true);
  });

  it('rejects non-object bodies', () => {
    expect('error' in validateStateBody(null)).toBe(true);
    expect('error' in validateStateBody(42)).toBe(true);
  });
});

describe('upsertState', () => {
  const empty: KnowledgeDebtStatesFile = {
    schemaVersion: 1,
    generatedAt: 1000,
    entries: [],
  };

  it('appends a fresh state entry', () => {
    const r = upsertState(
      empty,
      { clusterId: 'k1', state: 'INSTALLED', sizeAtState: 7 },
      2000,
    );
    expect(r.next.entries.length).toBe(1);
    expect(r.next.entries[0]!.clusterId).toBe('k1');
    expect(r.next.entries[0]!.state).toBe('INSTALLED');
    expect(r.next.entries[0]!.sizeAtState).toBe(7);
    expect(r.next.entries[0]!.updatedAt).toBe(2000);
  });

  it('replaces an existing entry in place when the cluster id matches', () => {
    const existing: KnowledgeDebtStatesFile = {
      schemaVersion: 1,
      generatedAt: 1000,
      entries: [
        { clusterId: 'k1', state: 'PENDING', updatedAt: 1, sizeAtState: 3 },
        { clusterId: 'k2', state: 'DISMISSED', updatedAt: 2, sizeAtState: 9 },
      ],
    };
    const r = upsertState(
      existing,
      { clusterId: 'k1', state: 'DISMISSED', sizeAtState: 8 },
      3000,
    );
    expect(r.next.entries.length).toBe(2);
    expect(r.next.entries[0]!.state).toBe('DISMISSED');
    expect(r.next.entries[0]!.sizeAtState).toBe(8);
    expect(r.next.entries[0]!.updatedAt).toBe(3000);
    // The other cluster is left untouched.
    expect(r.next.entries[1]!.clusterId).toBe('k2');
    expect(r.next.entries[1]!.sizeAtState).toBe(9);
  });
});
