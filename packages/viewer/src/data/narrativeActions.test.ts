// Tests for narrativeActions builders (Rev3-E E3 surface). Focused
// on `buildPatternFromNarrative`'s falsifierOverride wiring — the
// HTTP-side `encodePattern` lives behind a fetch boundary and is
// exercised by the integration tests in apps/standalone.

import { describe, it, expect } from 'vitest';
import type { Narrative } from '@chat-arch/schema';
import { buildPatternFromNarrative } from './narrativeActions.js';

function narrative(): Narrative {
  return {
    id: 'narr-1',
    projectId: 'proj-1',
    sentiment: 'positive',
    actionType: 'encode-as-pattern',
    title: 'Always run tests',
    body: 'Run `pnpm test` before merging.',
    generatedAt: '2026-01-02T00:00:00Z',
    evidence: [],
    schemaVersion: 1,
  };
}

describe('buildPatternFromNarrative — Rev3-E E3 falsifierOverride', () => {
  it('omits falsifierStatus by default (no override flag)', () => {
    const p = buildPatternFromNarrative(narrative(), false);
    expect(p.falsifierStatus).toBeUndefined();
  });

  it('omits falsifierStatus when falsifierOverride is false', () => {
    const p = buildPatternFromNarrative(narrative(), false, {
      falsifierOverride: false,
    });
    expect(p.falsifierStatus).toBeUndefined();
  });

  it('sets falsifierStatus="skipped-by-user" when falsifierOverride is true', () => {
    const p = buildPatternFromNarrative(narrative(), true, {
      falsifierOverride: true,
    });
    expect(p.falsifierStatus).toBe('skipped-by-user');
  });

  it('preserves appendedToClaudeMd independently of override flag', () => {
    const a = buildPatternFromNarrative(narrative(), false, {
      falsifierOverride: true,
    });
    const b = buildPatternFromNarrative(narrative(), true, {
      falsifierOverride: true,
    });
    expect(a.appendedToClaudeMd).toBe(false);
    expect(b.appendedToClaudeMd).toBe(true);
    expect(a.falsifierStatus).toBe('skipped-by-user');
    expect(b.falsifierStatus).toBe('skipped-by-user');
  });

  it('round-trips through JSON without losing the override signal', () => {
    const p = buildPatternFromNarrative(narrative(), false, {
      falsifierOverride: true,
    });
    const round = JSON.parse(JSON.stringify(p));
    expect(round.falsifierStatus).toBe('skipped-by-user');
  });
});
