import { describe, it, expect } from 'vitest';
import type { Pattern } from './pattern.js';

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
});
