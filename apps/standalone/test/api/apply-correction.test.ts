import { describe, expect, it } from 'vitest';
import type {
  AppliedImprovement,
  AppliedImprovementsFile,
  ProposedUpgrade,
} from '@chat-arch/schema';
import {
  REQUIRED_HEADER,
  applyToLedger,
  isLocalOrigin,
  isSameApplyKey,
  isValidProposedUpgrade,
  validateApplyBody,
  type ApplyCorrectionPayload,
} from '../../src/pages/api/apply-correction.js';

describe('apply-correction — CSRF gate', () => {
  it('accepts loopback origins, rejects everything else', () => {
    expect(isLocalOrigin('http://localhost:4324')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1')).toBe(true);
    expect(isLocalOrigin('http://[::1]')).toBe(true);
    expect(isLocalOrigin(null)).toBe(false);
    expect(isLocalOrigin('http://example.com')).toBe(false);
    expect(isLocalOrigin('file:///etc/passwd')).toBe(false);
    expect(isLocalOrigin('javascript:alert(1)')).toBe(false);
  });

  it('exposes a distinct X-Requested-With header from siblings', () => {
    // CSRF posture: each sibling endpoint pins a unique token so a
    // malicious page that learns one can't trip another.
    expect(REQUIRED_HEADER).toBe('chat-arch-apply-correction');
  });
});

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

describe('apply-correction — isValidProposedUpgrade', () => {
  it('accepts a fully-formed upgrade', () => {
    expect(isValidProposedUpgrade(upgrade())).toBe(true);
  });

  it('rejects unknown target enum values', () => {
    expect(isValidProposedUpgrade({ ...upgrade(), target: 'evil-write' })).toBe(false);
    expect(isValidProposedUpgrade({ ...upgrade(), target: 42 })).toBe(false);
  });

  it('rejects empty / non-string targetPath', () => {
    expect(isValidProposedUpgrade({ ...upgrade(), targetPath: '' })).toBe(false);
    expect(isValidProposedUpgrade({ ...upgrade(), targetPath: 7 })).toBe(false);
  });

  it('rejects non-bool applied / non-(null|number) appliedAt', () => {
    expect(isValidProposedUpgrade({ ...upgrade(), applied: 'yes' })).toBe(false);
    expect(isValidProposedUpgrade({ ...upgrade(), appliedAt: 'now' })).toBe(false);
  });

  it('rejects missing required fields', () => {
    const o = upgrade() as unknown as Record<string, unknown>;
    delete o.patch;
    expect(isValidProposedUpgrade(o)).toBe(false);
  });
});

describe('apply-correction — validateApplyBody', () => {
  const goodBody = {
    patternId: 'p-1',
    proposedUpgrade: upgrade(),
    ruleSummary: 'do not add docstrings',
  };

  it('accepts a minimal valid body', () => {
    const r = validateApplyBody(goodBody);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.patternId).toBe('p-1');
      expect(r.payload.targetFiles).toBeUndefined();
      expect(r.payload.notes).toBeUndefined();
    }
  });

  it('rejects null/non-object bodies', () => {
    expect(validateApplyBody(null).ok).toBe(false);
    expect(validateApplyBody('string').ok).toBe(false);
    expect(validateApplyBody(42).ok).toBe(false);
  });

  it('rejects empty / missing patternId', () => {
    const r = validateApplyBody({ ...goodBody, patternId: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects missing ruleSummary', () => {
    const r = validateApplyBody({ ...goodBody, ruleSummary: undefined });
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid proposedUpgrade', () => {
    const r = validateApplyBody({
      ...goodBody,
      proposedUpgrade: { target: 'evil', targetPath: '/etc/passwd' },
    });
    expect(r.ok).toBe(false);
  });

  it('coerces blank-stripping for targetFiles + notes', () => {
    const r = validateApplyBody({
      ...goodBody,
      targetFiles: ['  ~/.claude/CLAUDE.md ', '', '<repo>/CLAUDE.md'],
      notes: '   moved to PostToolUse   ',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.targetFiles).toEqual(['~/.claude/CLAUDE.md', '<repo>/CLAUDE.md']);
      expect(r.payload.notes).toBe('moved to PostToolUse');
    }
  });

  it('rejects a non-array targetFiles or non-string entries', () => {
    expect(validateApplyBody({ ...goodBody, targetFiles: 'one' }).ok).toBe(false);
    expect(validateApplyBody({ ...goodBody, targetFiles: [42] }).ok).toBe(false);
  });

  it('rejects an oversize notes value', () => {
    const huge = 'x'.repeat(5_000);
    expect(validateApplyBody({ ...goodBody, notes: huge }).ok).toBe(false);
  });

  it('rejects too many targetFiles entries', () => {
    const many = Array.from({ length: 17 }, (_v, i) => `f${i}`);
    expect(validateApplyBody({ ...goodBody, targetFiles: many }).ok).toBe(false);
  });
});

describe('apply-correction — isSameApplyKey', () => {
  it('matches on (patternId, target, targetPath) — all three must agree', () => {
    const e: AppliedImprovement = {
      id: 'e-1',
      patternId: 'p-1',
      appliedAt: 0,
      ruleSummary: 's',
      proposedUpgrade: upgrade({
        target: 'global-claude-md',
        targetPath: '~/.claude/CLAUDE.md',
      }),
    };
    expect(
      isSameApplyKey(e, 'p-1', { target: 'global-claude-md', targetPath: '~/.claude/CLAUDE.md' }),
    ).toBe(true);
    expect(
      isSameApplyKey(e, 'p-2', { target: 'global-claude-md', targetPath: '~/.claude/CLAUDE.md' }),
    ).toBe(false);
    expect(
      isSameApplyKey(e, 'p-1', { target: 'project-claude-md', targetPath: '~/.claude/CLAUDE.md' }),
    ).toBe(false);
    expect(
      isSameApplyKey(e, 'p-1', { target: 'global-claude-md', targetPath: '/other/path' }),
    ).toBe(false);
  });
});

function payload(overrides: Partial<ApplyCorrectionPayload> = {}): ApplyCorrectionPayload {
  return {
    patternId: 'p-1',
    proposedUpgrade: upgrade(),
    ruleSummary: 'r',
    ...overrides,
  };
}

function emptyLedger(): AppliedImprovementsFile {
  return { schemaVersion: 1, generatedAt: 0, entries: [] };
}

describe('apply-correction — applyToLedger (idempotency contract)', () => {
  it('appends a fresh entry when the key is new', () => {
    const { next, entry } = applyToLedger(
      emptyLedger(),
      payload(),
      1_700_000_000_000,
      'fresh-id',
    );
    expect(next.entries).toHaveLength(1);
    expect(entry.id).toBe('fresh-id');
    expect(entry.appliedAt).toBe(1_700_000_000_000);
    // The persisted upgrade has applied: true / appliedAt set.
    expect(entry.proposedUpgrade.applied).toBe(true);
    expect(entry.proposedUpgrade.appliedAt).toBe(1_700_000_000_000);
    expect(next.generatedAt).toBe(1_700_000_000_000);
  });

  it('replaces (does not duplicate) when re-applying the same (patternId, target, targetPath)', () => {
    const first = applyToLedger(
      emptyLedger(),
      payload({ notes: 'first try' }),
      1_700_000_000_000,
      'id-A',
    );
    const second = applyToLedger(
      first.next,
      payload({ notes: 'second try' }),
      1_700_500_000_000,
      'id-B',
    );
    expect(second.next.entries).toHaveLength(1);
    // Preserves the original id.
    expect(second.entry.id).toBe('id-A');
    // But updates fields from the new apply.
    expect(second.entry.notes).toBe('second try');
    expect(second.entry.appliedAt).toBe(1_700_500_000_000);
  });

  it('keeps siblings with different (target, targetPath) as separate entries', () => {
    const a = applyToLedger(
      emptyLedger(),
      payload({
        proposedUpgrade: upgrade({ target: 'global-claude-md', targetPath: '~/g.md' }),
      }),
      1_700_000_000_000,
      'id-A',
    );
    const b = applyToLedger(
      a.next,
      payload({
        proposedUpgrade: upgrade({ target: 'project-claude-md', targetPath: '<repo>/CLAUDE.md' }),
      }),
      1_700_500_000_000,
      'id-B',
    );
    expect(b.next.entries).toHaveLength(2);
    expect(b.entry.id).toBe('id-B');
    // Original entry untouched.
    expect(b.next.entries[0].id).toBe('id-A');
  });

  it('keeps siblings with different patternId as separate entries even when path matches', () => {
    const u = upgrade({ target: 'global-claude-md', targetPath: '~/.claude/CLAUDE.md' });
    const a = applyToLedger(
      emptyLedger(),
      payload({ patternId: 'p-1', proposedUpgrade: u }),
      1_700_000_000_000,
      'id-A',
    );
    const b = applyToLedger(
      a.next,
      payload({ patternId: 'p-2', proposedUpgrade: u }),
      1_700_500_000_000,
      'id-B',
    );
    expect(b.next.entries).toHaveLength(2);
  });
});
