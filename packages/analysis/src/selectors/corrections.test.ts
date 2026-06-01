import { describe, it, expect } from 'vitest';
import type { CorrectionPattern, ProposedUpgrade } from '@chat-arch/schema';
import {
  UNTAGGED_TOPIC,
  topicOf,
  sortPatterns,
  buildTopicBuckets,
} from './corrections.js';

function upgrade(overrides: Partial<ProposedUpgrade> = {}): ProposedUpgrade {
  return {
    target: 'global-claude-md',
    targetPath: '~/.claude/CLAUDE.md',
    patch: '- some rule',
    rationale: 'because',
    applied: false,
    appliedAt: null,
    ...overrides,
  };
}

function pattern(
  overrides: Partial<CorrectionPattern> & { id: string },
): CorrectionPattern {
  return {
    id: overrides.id,
    canonicalRule: overrides.canonicalRule ?? `rule ${overrides.id}`,
    instanceIds: overrides.instanceIds ?? [],
    occurrenceCount: overrides.occurrenceCount ?? 3,
    firstSeen: overrides.firstSeen ?? 1_700_000_000_000,
    lastSeen: overrides.lastSeen ?? 1_700_100_000_000,
    scope: overrides.scope ?? { kind: 'global' },
    proposedUpgrades: overrides.proposedUpgrades ?? [upgrade()],
    confidence: overrides.confidence ?? 0.7,
    recurringPostApplication: overrides.recurringPostApplication ?? false,
    alreadyEncoded: overrides.alreadyEncoded ?? false,
    topic: overrides.topic,
  };
}

describe('topicOf', () => {
  it('returns a trimmed topic when present', () => {
    expect(topicOf(pattern({ id: 'a', topic: '  Testing  ' }))).toBe('Testing');
  });
  it('falls back to the Untagged sentinel for missing/blank topic', () => {
    expect(topicOf(pattern({ id: 'a' }))).toBe(UNTAGGED_TOPIC);
    expect(topicOf(pattern({ id: 'b', topic: '   ' }))).toBe(UNTAGGED_TOPIC);
  });
});

describe('sortPatterns', () => {
  it('sorts recurring-after-applied to the top', () => {
    const recurring = pattern({ id: 'r', recurringPostApplication: true, confidence: 0.1 });
    const plain = pattern({ id: 'p', recurringPostApplication: false, confidence: 0.9 });
    expect([plain, recurring].sort(sortPatterns).map((p) => p.id)).toEqual(['r', 'p']);
  });
  it('breaks ties by confidence desc, then occurrenceCount desc', () => {
    const hi = pattern({ id: 'hi', confidence: 0.9, occurrenceCount: 1 });
    const lo = pattern({ id: 'lo', confidence: 0.5, occurrenceCount: 9 });
    const mid = pattern({ id: 'mid', confidence: 0.9, occurrenceCount: 5 });
    expect([lo, hi, mid].sort(sortPatterns).map((p) => p.id)).toEqual(['mid', 'hi', 'lo']);
  });
});

describe('buildTopicBuckets', () => {
  it('returns an empty array for no patterns', () => {
    expect(buildTopicBuckets([])).toEqual([]);
  });

  it('groups patterns by topic and aggregates weight', () => {
    const buckets = buildTopicBuckets([
      pattern({ id: 'a', topic: 'Testing', occurrenceCount: 2 }),
      pattern({ id: 'b', topic: 'Testing', occurrenceCount: 3 }),
      pattern({ id: 'c', topic: 'Scope', occurrenceCount: 1 }),
    ]);
    expect(buckets.map((b) => b.key)).toEqual(['Testing', 'Scope']);
    expect(buckets.find((b) => b.key === 'Testing')!.weight).toBe(5);
    expect(buckets.find((b) => b.key === 'Scope')!.weight).toBe(1);
  });

  it('dedups patterns by id (first occurrence wins)', () => {
    const buckets = buildTopicBuckets([
      pattern({ id: 'dup', topic: 'Testing', occurrenceCount: 2 }),
      pattern({ id: 'dup', topic: 'Testing', occurrenceCount: 99 }),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].patterns).toHaveLength(1);
    expect(buckets[0].weight).toBe(2);
  });

  it('orders buckets: recurring first, then weight desc, then label asc', () => {
    const buckets = buildTopicBuckets([
      pattern({ id: 'big', topic: 'Big', occurrenceCount: 100 }),
      pattern({ id: 'rec', topic: 'Recurring', occurrenceCount: 1, recurringPostApplication: true }),
      pattern({ id: 'amid', topic: 'Amid', occurrenceCount: 5 }),
      pattern({ id: 'zmid', topic: 'Zmid', occurrenceCount: 5 }),
    ]);
    // Recurring hoists above the heavier Big bucket; then weight desc; then
    // equal-weight Amid/Zmid break by label asc.
    expect(buckets.map((b) => b.key)).toEqual(['Recurring', 'Big', 'Amid', 'Zmid']);
  });

  it('pins the Untagged bucket to the bottom regardless of weight', () => {
    const buckets = buildTopicBuckets([
      pattern({ id: 'u1', occurrenceCount: 100 }), // untagged, heaviest
      pattern({ id: 'u2', occurrenceCount: 50 }),
      pattern({ id: 't1', topic: 'Testing', occurrenceCount: 1 }),
    ]);
    expect(buckets[buckets.length - 1].key).toBe(UNTAGGED_TOPIC);
    const untagged = buckets.find((b) => b.key === UNTAGGED_TOPIC)!;
    expect(untagged.label).toBe('UNTAGGED · re-mine to assign');
    expect(untagged.weight).toBe(150);
  });

  it('labels named topics in upper case and sorts patterns within a bucket', () => {
    const buckets = buildTopicBuckets([
      pattern({ id: 'plain', topic: 'Testing', recurringPostApplication: false, confidence: 0.9 }),
      pattern({ id: 'rec', topic: 'Testing', recurringPostApplication: true, confidence: 0.1 }),
    ]);
    expect(buckets[0].label).toBe('TESTING');
    expect(buckets[0].patterns.map((p) => p.id)).toEqual(['rec', 'plain']);
  });

  it('sets hasRecurring / hasEncoded flags correctly', () => {
    const [bucket] = buildTopicBuckets([
      pattern({ id: 'enc', topic: 'T', alreadyEncoded: true }),
      pattern({ id: 'rec', topic: 'T', recurringPostApplication: true }),
    ]);
    expect(bucket.hasRecurring).toBe(true);
    expect(bucket.hasEncoded).toBe(true);
  });
});
