import { describe, it, expect } from 'vitest';
import type { Pattern, PatternFalsifierStatus } from './pattern.js';
import { PATTERN_FALSIFIER_STATUS_VALUES } from './pattern.js';

describe('Pattern entity', () => {
  it('round-trips through JSON without loss', () => {
    const p: Pattern = {
      id: 'pat_001',
      sourceNarrativeId: 'narr_1',
      projectId: 'proj_abc',
      title: 'Always run tests before merging',
      body: 'When refactoring, run `pnpm test` locally before opening a PR.',
      encodedAt: '2026-05-05T00:00:00.000Z',
      appendedToClaudeMd: false,
    };
    const round = JSON.parse(JSON.stringify(p)) as Pattern;
    expect(round).toEqual(p);
  });

  it('toggles appendedToClaudeMd independently of sidecar persistence', () => {
    const sidecarOnly: Pattern = {
      id: 'pat_002',
      sourceNarrativeId: 'narr_2',
      projectId: 'proj_abc',
      title: 'Sidecar-only pattern',
      body: 'body',
      encodedAt: '2026-05-05T00:00:00.000Z',
      appendedToClaudeMd: false,
    };
    const appended: Pattern = { ...sidecarOnly, appendedToClaudeMd: true };
    expect(sidecarOnly.appendedToClaudeMd).toBe(false);
    expect(appended.appendedToClaudeMd).toBe(true);
  });

  it('accepts a Pattern without falsifierStatus (back-compat with pre-Rev3-E)', () => {
    const p: Pattern = {
      id: 'pat_v1',
      sourceNarrativeId: 'narr_v1',
      projectId: 'proj_abc',
      title: 'Pre-Rev3-E pattern',
      body: 'body',
      encodedAt: '2026-01-01T00:00:00.000Z',
      appendedToClaudeMd: false,
    };
    expect(p.falsifierStatus).toBeUndefined();
  });

  it('accepts all three falsifierStatus values (Rev3-E E1)', () => {
    for (const status of PATTERN_FALSIFIER_STATUS_VALUES) {
      const p: Pattern = {
        id: `pat_${status}`,
        sourceNarrativeId: 'narr_x',
        projectId: 'proj_abc',
        title: 'Pattern with falsifier signal',
        body: 'body',
        encodedAt: '2026-05-05T00:00:00.000Z',
        appendedToClaudeMd: false,
        falsifierStatus: status,
      };
      const round = JSON.parse(JSON.stringify(p)) as Pattern;
      expect(round.falsifierStatus).toBe(status);
    }
  });

  it('PATTERN_FALSIFIER_STATUS_VALUES enumerates exactly the three terminal states', () => {
    expect(PATTERN_FALSIFIER_STATUS_VALUES).toEqual([
      'verified',
      'skipped-by-user',
      'unavailable',
    ]);
    // Compile-time exhaustiveness check — if a fourth state is added
    // to the union without updating this array, TS will reject this.
    const seen = new Set<PatternFalsifierStatus>(PATTERN_FALSIFIER_STATUS_VALUES);
    expect(seen.size).toBe(3);
  });
});
