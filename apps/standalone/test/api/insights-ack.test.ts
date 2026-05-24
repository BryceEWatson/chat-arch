/**
 * Pure-function tests for the insights-ack endpoint helpers.
 *
 * Exercises:
 *   - validateAckBody — accepts valid bodies, rejects malformed ones
 *   - ackToLedger — adds new entries, no-ops on duplicates (idempotent)
 */
import { describe, expect, it } from 'vitest';
import {
  ackToLedger,
  validateAckBody,
  type InsightsAcksFile,
} from '../../src/pages/api/insights-ack.js';

describe('validateAckBody', () => {
  it('accepts a valid ITS-contrast ack', () => {
    const r = validateAckBody({ id: 'abc:CLAUDE.md', kind: 'its-contrast' });
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.id).toBe('abc:CLAUDE.md');
      expect(r.kind).toBe('its-contrast');
    }
  });

  it('rejects unknown kinds', () => {
    const r = validateAckBody({ id: 'x', kind: 'bogus' });
    expect('error' in r).toBe(true);
  });

  it('rejects missing id', () => {
    const r = validateAckBody({ kind: 'its-contrast' });
    expect('error' in r).toBe(true);
  });

  it('rejects oversized id', () => {
    const r = validateAckBody({ id: 'x'.repeat(300), kind: 'its-contrast' });
    expect('error' in r).toBe(true);
  });

  it('rejects non-object bodies', () => {
    expect('error' in validateAckBody(null)).toBe(true);
    expect('error' in validateAckBody('hello')).toBe(true);
    expect('error' in validateAckBody(42)).toBe(true);
  });
});

describe('ackToLedger', () => {
  const empty: InsightsAcksFile = {
    schemaVersion: 1,
    generatedAt: 1000,
    entries: [],
  };

  it('appends a fresh ack to an empty ledger', () => {
    const r = ackToLedger(
      empty,
      { id: 'abc', kind: 'its-contrast' },
      2000,
    );
    expect(r.existed).toBe(false);
    expect(r.next.entries.length).toBe(1);
    expect(r.next.entries[0]!.id).toBe('abc');
    expect(r.next.entries[0]!.acknowledgedAt).toBe(2000);
  });

  it('is idempotent on duplicate (kind, id)', () => {
    const seeded: InsightsAcksFile = {
      schemaVersion: 1,
      generatedAt: 1000,
      entries: [{ id: 'abc', kind: 'its-contrast', acknowledgedAt: 500 }],
    };
    const r = ackToLedger(
      seeded,
      { id: 'abc', kind: 'its-contrast' },
      3000,
    );
    expect(r.existed).toBe(true);
    expect(r.next).toBe(seeded); // no mutation
    expect(r.entry.acknowledgedAt).toBe(500); // original timestamp preserved
  });

  it('treats (id, kind) as the composite key — same id, different kind is fresh', () => {
    const seeded: InsightsAcksFile = {
      schemaVersion: 1,
      generatedAt: 1000,
      entries: [{ id: 'abc', kind: 'its-contrast', acknowledgedAt: 500 }],
    };
    const r = ackToLedger(
      seeded,
      { id: 'abc', kind: 'knowledge-debt' },
      4000,
    );
    expect(r.existed).toBe(false);
    expect(r.next.entries.length).toBe(2);
  });
});
