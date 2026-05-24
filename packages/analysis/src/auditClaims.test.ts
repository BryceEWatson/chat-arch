import { describe, it, expect } from 'vitest';
import { extractClaims } from './auditClaims.js';

describe('extractClaims', () => {
  it('returns no claims for an empty session', () => {
    const r = extractClaims('s1', 'cowork', []);
    expect(r.claims).toEqual([]);
    expect(r.totalsByClaimType['fix-claim']).toBe(0);
  });

  it('detects a fix-claim with leading personal pronoun', () => {
    const r = extractClaims('s1', 'cowork', [
      { lineNumber: 42, text: "I've fixed the bug in the auth handler." },
    ]);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]?.claimType).toBe('fix-claim');
    expect(r.claims[0]?.lineNumber).toBe(42);
    expect(r.claims[0]?.span).toMatch(/fixed/i);
  });

  it('detects tests-pass-claim variants', () => {
    const r = extractClaims('s1', 'cowork', [
      { lineNumber: 1, text: 'All 234 tests pass.' },
      { lineNumber: 2, text: 'every test passed cleanly' },
    ]);
    expect(r.claims).toHaveLength(2);
    expect(r.claims.every((c) => c.claimType === 'tests-pass-claim')).toBe(true);
  });

  it('detects build-pass-claim', () => {
    const r = extractClaims('s1', 'cowork', [
      { lineNumber: 10, text: 'The build passes locally and on CI.' },
    ]);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]?.claimType).toBe('build-pass-claim');
  });

  it('detects addition-claim across nouns', () => {
    const r = extractClaims('s1', 'cowork', [
      { lineNumber: 5, text: 'Added a helper for cosine distance.' },
      { lineNumber: 6, text: 'I implemented the missing function.' },
    ]);
    expect(r.claims).toHaveLength(2);
    expect(r.claims.every((c) => c.claimType === 'addition-claim')).toBe(true);
  });

  it('detects verification-claim', () => {
    const r = extractClaims('s1', 'cowork', [
      { lineNumber: 1, text: 'I verified that this works against the real corpus.' },
    ]);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]?.claimType).toBe('verification-claim');
  });

  it('detects completion-claim', () => {
    const r = extractClaims('s1', 'cowork', [
      { lineNumber: 1, text: 'Nothing else to change here.' },
      { lineNumber: 2, text: 'nothing left to do on this branch.' },
    ]);
    expect(r.claims).toHaveLength(2);
    expect(r.claims.every((c) => c.claimType === 'completion-claim')).toBe(true);
  });

  it('returns multiple matches within one message', () => {
    const r = extractClaims('s1', 'cowork', [
      { lineNumber: 1, text: 'Fixed the parser. Also fixed the formatter.' },
    ]);
    expect(r.claims).toHaveLength(2);
    expect(r.claims.every((c) => c.claimType === 'fix-claim')).toBe(true);
  });

  it('attaches surrounding context but caps total length', () => {
    const longText = 'lorem '.repeat(200) + 'tests pass' + ' ipsum'.repeat(200);
    const r = extractClaims('s1', 'cowork', [{ lineNumber: 1, text: longText }]);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]?.surroundingContext.length).toBeLessThan(500);
    expect(r.claims[0]?.surroundingContext).toContain('tests pass');
  });

  it('aggregates totalsByClaimType correctly', () => {
    const r = extractClaims('s1', 'cowork', [
      { lineNumber: 1, text: 'fixed the bug. tests pass. I implemented the feature.' },
    ]);
    expect(r.totalsByClaimType['fix-claim']).toBe(1);
    expect(r.totalsByClaimType['tests-pass-claim']).toBe(1);
    expect(r.totalsByClaimType['addition-claim']).toBe(1);
  });

  it('preserves session id + source on every claim', () => {
    const r = extractClaims('sid-99', 'cli-direct', [
      { lineNumber: 1, text: 'Fixed it.' },
    ]);
    expect(r.claims[0]?.sessionId).toBe('sid-99');
    expect(r.claims[0]?.source).toBe('cli-direct');
  });
});
