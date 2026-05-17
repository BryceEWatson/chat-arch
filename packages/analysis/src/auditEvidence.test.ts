import { describe, it, expect } from 'vitest';
import type { AuditClaim } from '@chat-arch/schema';
import { verifyOneClaim, verifySessions, type TimelineEvent } from './auditEvidence.js';

function claim(overrides: Partial<AuditClaim> & Pick<AuditClaim, 'claimType' | 'lineNumber'>): AuditClaim {
  return {
    sessionId: 's1',
    source: 'cowork',
    lineNumber: overrides.lineNumber,
    claimType: overrides.claimType,
    span: 'span',
    surroundingContext: 'ctx',
    ...overrides,
  };
}

describe('verifyOneClaim', () => {
  it('returns inconclusive when the claim line is not in the timeline', () => {
    const r = verifyOneClaim(claim({ claimType: 'fix-claim', lineNumber: 99 }), []);
    expect(r.outcome).toBe('inconclusive');
  });

  it('passes a fix-claim when an Edit follows in the window', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 10, text: 'I fixed it.' },
      { kind: 'tool_use', lineNumber: 11, name: 'Edit', input: {} },
    ];
    const r = verifyOneClaim(claim({ claimType: 'fix-claim', lineNumber: 10 }), timeline);
    expect(r.outcome).toBe('pass');
    expect(r.reason).toContain('Edit at line 11');
  });

  it('fails a fix-claim when no Edit/Write appears in the window', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'fixed it' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'ls' } },
    ];
    const r = verifyOneClaim(claim({ claimType: 'fix-claim', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('fail');
  });

  it('passes a tests-pass-claim when Bash + clean tool_result follow', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'all tests pass' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'pnpm test' } },
      { kind: 'tool_result', lineNumber: 3, text: 'all good', isError: false },
    ];
    const r = verifyOneClaim(claim({ claimType: 'tests-pass-claim', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('fails a tests-pass-claim when tool_result is_error', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'all tests pass' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'pnpm test' } },
      { kind: 'tool_result', lineNumber: 3, text: '', isError: true },
    ];
    const r = verifyOneClaim(claim({ claimType: 'tests-pass-claim', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('fail');
  });

  it('fails a tests-pass-claim when result text contains failure markers', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'tests pass' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'pnpm test' } },
      { kind: 'tool_result', lineNumber: 3, text: '2 failed | 800 passed', isError: false },
    ];
    const r = verifyOneClaim(claim({ claimType: 'tests-pass-claim', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('fail');
  });

  it('passes a verification-claim when ANY tool follows', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'I verified this works' },
      { kind: 'tool_use', lineNumber: 2, name: 'Read', input: {} },
    ];
    const r = verifyOneClaim(claim({ claimType: 'verification-claim', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('marks completion-claim as fail when user pushback follows', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'nothing else to do' },
      { kind: 'user', lineNumber: 2, text: 'but the API is still broken' },
    ];
    const r = verifyOneClaim(claim({ claimType: 'completion-claim', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('fail');
  });

  it('marks completion-claim as pass when no pushback over user turns', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'nothing else to do' },
      { kind: 'user', lineNumber: 2, text: 'thanks, that works!' },
    ];
    const r = verifyOneClaim(claim({ claimType: 'completion-claim', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('marks completion-claim as inconclusive when no further user turns exist', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'nothing else to do' },
    ];
    const r = verifyOneClaim(claim({ claimType: 'completion-claim', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('inconclusive');
  });
});

describe('verifySessions', () => {
  it('aggregates totals + byClaimType across sessions', () => {
    const timelineGood: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'fixed' },
      { kind: 'tool_use', lineNumber: 2, name: 'Edit', input: {} },
    ];
    const timelineBad: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'fixed' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: {} },
    ];
    const r = verifySessions(
      [
        {
          sessionId: 'good',
          timeline: timelineGood,
          claims: [claim({ sessionId: 'good', claimType: 'fix-claim', lineNumber: 1 })],
        },
        {
          sessionId: 'bad',
          timeline: timelineBad,
          claims: [claim({ sessionId: 'bad', claimType: 'fix-claim', lineNumber: 1 })],
        },
      ],
      1_000_000,
    );
    expect(r.summary.totals.pass).toBe(1);
    expect(r.summary.totals.fail).toBe(1);
    expect(r.summary.byClaimType['fix-claim']?.pass).toBe(1);
    expect(r.summary.byClaimType['fix-claim']?.fail).toBe(1);
    expect(r.summary.topFailureClaimTypes[0]?.claimType).toBe('fix-claim');
  });

  it('rolls up by project key when provided', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'fixed' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: {} },
    ];
    const r = verifySessions(
      [
        {
          sessionId: 's1',
          projectKey: 'proj-a',
          timeline,
          claims: [claim({ sessionId: 's1', claimType: 'fix-claim', lineNumber: 1 })],
        },
      ],
      1_000_000,
    );
    expect(r.summary.byProject?.['proj-a']?.fail).toBe(1);
  });
});
