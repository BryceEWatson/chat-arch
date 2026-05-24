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

  // ---- v2 outcome-substrate families ----

  it('passes gh-pr-opened when Bash gh pr create + clean tool_result follow', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: "I'll open a PR." },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'gh pr create --title "x"' } },
      { kind: 'tool_result', lineNumber: 3, text: 'https://github.com/x/y/pull/1', isError: false },
    ];
    const r = verifyOneClaim(claim({ claimType: 'gh-pr-opened', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('fails gh-pr-opened when no gh pr create appears in window', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'opened a PR' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'git status' } },
    ];
    const r = verifyOneClaim(claim({ claimType: 'gh-pr-opened', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('fail');
  });

  it('marks gh-pr-opened inconclusive when Bash exists but no tool_result captured', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'opening PR' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'gh pr create' } },
    ];
    const r = verifyOneClaim(claim({ claimType: 'gh-pr-opened', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('inconclusive');
  });

  it('passes gh-pr-merged when Bash gh pr merge + clean tool_result follow', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'merged the PR' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'gh pr merge 42 --squash' } },
      { kind: 'tool_result', lineNumber: 3, text: 'merged', isError: false },
    ];
    const r = verifyOneClaim(claim({ claimType: 'gh-pr-merged', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('fails gh-pr-merged when Bash tool_result is_error', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'merging' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'gh pr merge 42' } },
      { kind: 'tool_result', lineNumber: 3, text: '', isError: true },
    ];
    const r = verifyOneClaim(claim({ claimType: 'gh-pr-merged', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('fail');
  });

  it('passes gh-pr-closed-unmerged via gh pr close', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'closed the PR without merging' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'gh pr close 42' } },
      { kind: 'tool_result', lineNumber: 3, text: 'closed', isError: false },
    ];
    const r = verifyOneClaim(claim({ claimType: 'gh-pr-closed-unmerged', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('passes git-revert via git revert', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: "I'll revert that commit" },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'git revert abc123' } },
      { kind: 'tool_result', lineNumber: 3, text: 'Revert "x"', isError: false },
    ];
    const r = verifyOneClaim(claim({ claimType: 'git-revert', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('passes git-reset-hard via git reset --hard', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: "let's hard reset" },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'git reset --hard origin/main' } },
      { kind: 'tool_result', lineNumber: 3, text: 'HEAD is now at deadbeef', isError: false },
    ];
    const r = verifyOneClaim(claim({ claimType: 'git-reset-hard', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('fails git-reset-hard when no matching command in window', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'reset hard' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'git reset --soft HEAD~' } },
    ];
    const r = verifyOneClaim(claim({ claimType: 'git-reset-hard', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('fail');
  });

  it('passes git-force-push via git push --force', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'force pushing' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'git push --force origin feature' } },
      { kind: 'tool_result', lineNumber: 3, text: 'pushed', isError: false },
    ];
    const r = verifyOneClaim(claim({ claimType: 'git-force-push', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('passes git-force-push via git push --force-with-lease', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'force pushing with lease' },
      { kind: 'tool_use', lineNumber: 2, name: 'Bash', input: { command: 'git push --force-with-lease origin feature' } },
      { kind: 'tool_result', lineNumber: 3, text: 'pushed', isError: false },
    ];
    const r = verifyOneClaim(claim({ claimType: 'git-force-push', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('passes affirmation when user replies "perfect"', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'ready for review' },
      { kind: 'user', lineNumber: 2, text: 'perfect, thanks!' },
    ];
    const r = verifyOneClaim(claim({ claimType: 'affirmation', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('passes affirmation on "looks good"', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'how does this look' },
      { kind: 'user', lineNumber: 2, text: 'that looks good to me' },
    ];
    const r = verifyOneClaim(claim({ claimType: 'affirmation', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('pass');
  });

  it('fails affirmation when user moves on without acknowledging', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'ready for review' },
      { kind: 'user', lineNumber: 2, text: 'next thing — fix the build' },
    ];
    const r = verifyOneClaim(claim({ claimType: 'affirmation', lineNumber: 1 }), timeline);
    expect(r.outcome).toBe('fail');
  });

  it('marks affirmation inconclusive when no further user turns', () => {
    const timeline: TimelineEvent[] = [
      { kind: 'assistant', lineNumber: 1, text: 'ready for review' },
    ];
    const r = verifyOneClaim(claim({ claimType: 'affirmation', lineNumber: 1 }), timeline);
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
