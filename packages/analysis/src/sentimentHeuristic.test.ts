import { describe, it, expect } from 'vitest';
import { scoreSentiment } from './sentimentHeuristic.js';

describe('scoreSentiment', () => {
  it('returns neutral for empty input', () => {
    expect(scoreSentiment('').sentiment).toBe('neutral');
  });

  it('detects positive markers', () => {
    expect(scoreSentiment('All tests pass; merged.').sentiment).toBe('positive');
    expect(scoreSentiment('shipped feature').sentiment).toBe('positive');
    expect(scoreSentiment('fixed the bug, deploy succeeded').sentiment).toBe('positive');
  });

  it('detects negative markers', () => {
    expect(scoreSentiment("doesn't work").sentiment).toBe('negative');
    expect(scoreSentiment('build failed and is broken').sentiment).toBe('negative');
    expect(scoreSentiment('I am stuck on this error').sentiment).toBe('negative');
  });

  it('returns neutral when neither dominates', () => {
    expect(scoreSentiment('hello world').sentiment).toBe('neutral');
  });

  it('weighs more hits as the stronger polarity', () => {
    const r = scoreSentiment('shipped, merged, fixed, but found a small bug');
    expect(r.sentiment).toBe('positive');
    expect(r.positiveHits).toBeGreaterThan(r.negativeHits);
  });
});
