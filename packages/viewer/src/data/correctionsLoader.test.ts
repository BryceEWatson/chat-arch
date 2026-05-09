import { describe, it, expect } from 'vitest';
import type {
  AppliedImprovement,
  AppliedImprovementsFile,
  CorrectionPattern,
  CorrectionsFile,
  ProposedUpgrade,
} from '@chat-arch/schema';
import { mergeAppliedImprovements } from './correctionsLoader.js';

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

function pattern(overrides: Partial<CorrectionPattern> & { id: string }): CorrectionPattern {
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
  };
}

function file(patterns: readonly CorrectionPattern[]): CorrectionsFile {
  return {
    generatedAt: 1_700_000_000_000,
    corrections: [],
    patterns,
    pipeline: {
      heuristicRecall: true,
      llmClassification: true,
      embeddingClustering: true,
      claudeMdCrossCheck: true,
    },
  };
}

function entry(overrides: Partial<AppliedImprovement> & { id: string; patternId: string }): AppliedImprovement {
  return {
    id: overrides.id,
    patternId: overrides.patternId,
    appliedAt: overrides.appliedAt ?? 1_700_050_000_000,
    ruleSummary: overrides.ruleSummary ?? 'rule summary',
    proposedUpgrade: overrides.proposedUpgrade ?? upgrade({ applied: true, appliedAt: 1_700_050_000_000 }),
    ...(overrides.targetFiles ? { targetFiles: overrides.targetFiles } : {}),
    ...(overrides.notes ? { notes: overrides.notes } : {}),
  };
}

function ledger(entries: AppliedImprovement[]): AppliedImprovementsFile {
  return { schemaVersion: 1, generatedAt: Date.now(), entries };
}

describe('mergeAppliedImprovements', () => {
  it('returns the input unchanged when the ledger is null or empty', () => {
    const corrections = file([pattern({ id: 'p1' })]);
    expect(mergeAppliedImprovements(corrections, null)).toBe(corrections);
    expect(
      mergeAppliedImprovements(corrections, ledger([])),
    ).toBe(corrections);
  });

  it('stamps applied/appliedAt onto the matching ProposedUpgrade by (target, targetPath)', () => {
    const u = upgrade({
      target: 'project-claude-md',
      targetPath: '<repo>/CLAUDE.md',
    });
    const corrections = file([
      pattern({ id: 'p1', proposedUpgrades: [u] }),
    ]);
    const e = entry({
      id: 'a-1',
      patternId: 'p1',
      appliedAt: 1_700_080_000_000,
      proposedUpgrade: {
        ...u,
        applied: true,
        appliedAt: 1_700_080_000_000,
      },
    });
    const merged = mergeAppliedImprovements(corrections, ledger([e]));
    const mergedUpgrade = merged.patterns[0].proposedUpgrades[0];
    expect(mergedUpgrade.applied).toBe(true);
    expect(mergedUpgrade.appliedAt).toBe(1_700_080_000_000);
    // Original ProposedUpgrade is left untouched (pure merge).
    expect(u.applied).toBe(false);
    expect(u.appliedAt).toBeNull();
  });

  it('does NOT match when only patternId matches but target/path differ', () => {
    const u = upgrade({ target: 'global-claude-md', targetPath: '~/.claude/CLAUDE.md' });
    const corrections = file([pattern({ id: 'p1', proposedUpgrades: [u] })]);
    const ledgerEntry = entry({
      id: 'a-1',
      patternId: 'p1',
      proposedUpgrade: upgrade({
        target: 'skill',
        targetPath: '~/.claude/skills/foo/SKILL.md',
        applied: true,
        appliedAt: 1_700_080_000_000,
      }),
    });
    const merged = mergeAppliedImprovements(corrections, ledger([ledgerEntry]));
    const mergedUpgrade = merged.patterns[0].proposedUpgrades[0];
    // The live upgrade is unmodified — its (target, path) did not match.
    expect(mergedUpgrade.applied).toBe(false);
    expect(mergedUpgrade.appliedAt).toBeNull();
  });

  it('flips recurringPostApplication when pattern.lastSeen > maxAppliedAt', () => {
    const u = upgrade();
    const corrections = file([
      pattern({
        id: 'p1',
        proposedUpgrades: [u],
        // Applied earlier; the pattern recurred AFTER the apply.
        lastSeen: 1_700_200_000_000,
        recurringPostApplication: false,
      }),
    ]);
    const e = entry({
      id: 'a-1',
      patternId: 'p1',
      appliedAt: 1_700_100_000_000,
    });
    const merged = mergeAppliedImprovements(corrections, ledger([e]));
    expect(merged.patterns[0].recurringPostApplication).toBe(true);
  });

  it('does NOT flip recurringPostApplication when pattern.lastSeen <= maxAppliedAt', () => {
    const u = upgrade();
    const corrections = file([
      pattern({
        id: 'p1',
        proposedUpgrades: [u],
        lastSeen: 1_700_050_000_000,
        recurringPostApplication: false,
      }),
    ]);
    const e = entry({
      id: 'a-1',
      patternId: 'p1',
      appliedAt: 1_700_100_000_000, // applied AFTER lastSeen
    });
    const merged = mergeAppliedImprovements(corrections, ledger([e]));
    expect(merged.patterns[0].recurringPostApplication).toBe(false);
  });

  it('preserves the original recurringPostApplication when no upgrade matches and no ledger entries land', () => {
    const corrections = file([
      pattern({
        id: 'p1',
        // pre-existing recurring flag from the mining pipeline
        recurringPostApplication: true,
      }),
    ]);
    // Ledger has no entry for p1.
    const e = entry({ id: 'a-1', patternId: 'pZ' });
    const merged = mergeAppliedImprovements(corrections, ledger([e]));
    expect(merged.patterns[0].recurringPostApplication).toBe(true);
  });

  it('uses max appliedAt across multiple ledger entries for the same pattern', () => {
    const u1 = upgrade({ target: 'global-claude-md', targetPath: '~/global.md' });
    const u2 = upgrade({ target: 'project-claude-md', targetPath: '~/project.md' });
    const corrections = file([
      pattern({
        id: 'p1',
        proposedUpgrades: [u1, u2],
        // lastSeen falls between the two appliedAt values.
        lastSeen: 1_700_150_000_000,
      }),
    ]);
    const merged = mergeAppliedImprovements(
      corrections,
      ledger([
        entry({
          id: 'e1',
          patternId: 'p1',
          appliedAt: 1_700_080_000_000,
          proposedUpgrade: { ...u1, applied: true, appliedAt: 1_700_080_000_000 },
        }),
        entry({
          id: 'e2',
          patternId: 'p1',
          appliedAt: 1_700_200_000_000, // after lastSeen
          proposedUpgrade: { ...u2, applied: true, appliedAt: 1_700_200_000_000 },
        }),
      ]),
    );
    // lastSeen 1_700_150_000_000 is < max(1_700_080, 1_700_200) ⇒ NOT recurring.
    expect(merged.patterns[0].recurringPostApplication).toBe(false);
    // Both upgrades stamped applied.
    expect(merged.patterns[0].proposedUpgrades[0].applied).toBe(true);
    expect(merged.patterns[0].proposedUpgrades[1].applied).toBe(true);
  });

  it('ignores ledger entries whose patternId does not exist in corrections', () => {
    const corrections = file([pattern({ id: 'p1' })]);
    const merged = mergeAppliedImprovements(
      corrections,
      ledger([entry({ id: 'orphan', patternId: 'gone' })]),
    );
    expect(merged.patterns).toHaveLength(1);
    expect(merged.patterns[0].id).toBe('p1');
    expect(merged.patterns[0].recurringPostApplication).toBe(false);
  });
});
