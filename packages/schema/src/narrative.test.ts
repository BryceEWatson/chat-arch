import { describe, it, expect } from 'vitest';
import {
  validateNarrative,
  InvalidNarrativeError,
  type Narrative,
} from './narrative.js';
import { UNASSIGNED_PROJECT_ID } from './project.js';
import { actionForSentiment } from './sentiment.js';

function baseNarrative(overrides: Partial<Narrative> = {}): Narrative {
  return {
    id: 'narr_1',
    projectId: 'proj_abc',
    sessionIds: ['s1', 's2'],
    sentiment: 'positive',
    title: 'Test-first refactor pattern',
    body: 'Sessions consistently shipped when tests preceded implementation.',
    evidence: [{ sessionId: 's1', excerpt: 'tests pass' }],
    generatedAt: '2026-05-05T00:00:00.000Z',
    actionType: 'encode-as-pattern',
    ...overrides,
  };
}

describe('Narrative entity', () => {
  it('round-trips through JSON without loss', () => {
    const n = baseNarrative();
    const round = JSON.parse(JSON.stringify(n)) as Narrative;
    expect(round).toEqual(n);
  });

  it('rejects narratives attached to UNASSIGNED', () => {
    const n = baseNarrative({ projectId: UNASSIGNED_PROJECT_ID });
    expect(() => validateNarrative(n)).toThrow(InvalidNarrativeError);
  });

  it('rejects narratives with neutral sentiment', () => {
    // forced cast: type forbids this at compile time, but runtime guard exists for safety
    const n = baseNarrative({ sentiment: 'neutral' as 'positive' });
    expect(() => validateNarrative(n)).toThrow(InvalidNarrativeError);
  });

  it('rejects sentiment/actionType mismatches', () => {
    const n = baseNarrative({
      sentiment: 'negative',
      actionType: 'encode-as-pattern',
    });
    expect(() => validateNarrative(n)).toThrow(InvalidNarrativeError);
  });

  it('accepts a valid positive narrative', () => {
    expect(() => validateNarrative(baseNarrative())).not.toThrow();
  });

  it('accepts a valid negative narrative', () => {
    const n = baseNarrative({
      sentiment: 'negative',
      actionType: 'generate-corrective-prompt',
    });
    expect(() => validateNarrative(n)).not.toThrow();
  });

  it('actionForSentiment maps correctly', () => {
    expect(actionForSentiment('positive')).toBe('encode-as-pattern');
    expect(actionForSentiment('negative')).toBe('generate-corrective-prompt');
    expect(actionForSentiment('neutral')).toBeNull();
  });
});
