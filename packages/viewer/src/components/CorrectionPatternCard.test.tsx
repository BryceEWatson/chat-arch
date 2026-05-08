import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type {
  Correction,
  CorrectionPattern,
  ProposedUpgrade,
} from '@chat-arch/schema';
import { CorrectionPatternCard } from './CorrectionPatternCard.js';

afterEach(() => cleanup());

function correction(id: string, overrides: Partial<Correction> = {}): Correction {
  return {
    id,
    sessionId: `s-${id}`,
    userTurnIndex: 0,
    excerpt: `please ${id} stop using docstrings`,
    precedingAssistantExcerpt: `here is some code with ${id} docstrings`,
    signals: [{ kind: 'explicit-stop', phrase: 'stop' }],
    classification: {
      kind: 'behavior-rule',
      distilledRule: 'do not add docstrings unless asked',
      confidence: 0.85,
      actionable: true,
    },
    ...overrides,
  };
}

function upgrade(overrides: Partial<ProposedUpgrade> = {}): ProposedUpgrade {
  return {
    target: 'global-claude-md',
    targetPath: '~/.claude/CLAUDE.md',
    patch: '- Do not add docstrings unless asked.',
    rationale: 'Pattern recurs across 5 sessions and 3 projects — global rule.',
    applied: false,
    appliedAt: null,
    ...overrides,
  };
}

function pattern(overrides: Partial<CorrectionPattern> = {}): CorrectionPattern {
  return {
    id: 'p-1',
    canonicalRule: 'Do not add docstrings unless asked',
    instanceIds: ['c1', 'c2', 'c3'],
    occurrenceCount: 3,
    firstSeen: 1_700_000_000_000,
    lastSeen: 1_700_100_000_000,
    scope: { kind: 'global' },
    proposedUpgrades: [upgrade()],
    confidence: 0.9,
    recurringPostApplication: false,
    alreadyEncoded: false,
    ...overrides,
  };
}

function buildInstancesById(ids: readonly string[]): Map<string, Correction> {
  const m = new Map<string, Correction>();
  for (const id of ids) m.set(id, correction(id));
  return m;
}

describe('CorrectionPatternCard', () => {
  it('renders the canonical rule and occurrence count', () => {
    const p = pattern();
    render(<CorrectionPatternCard pattern={p} instancesById={buildInstancesById(p.instanceIds)} />);
    expect(screen.getByText('Do not add docstrings unless asked')).toBeDefined();
    expect(screen.getByText('×3')).toBeDefined();
  });

  it('shows the ALREADY ENCODED badge when alreadyEncoded is set', () => {
    const p = pattern({ alreadyEncoded: true });
    render(<CorrectionPatternCard pattern={p} instancesById={buildInstancesById(p.instanceIds)} />);
    expect(screen.getByText('ALREADY ENCODED')).toBeDefined();
  });

  it('shows the RECURRING AFTER APPLIED badge (overrides alreadyEncoded)', () => {
    const p = pattern({ recurringPostApplication: true, alreadyEncoded: true });
    render(<CorrectionPatternCard pattern={p} instancesById={buildInstancesById(p.instanceIds)} />);
    expect(screen.getByText('RECURRING AFTER APPLIED')).toBeDefined();
    expect(screen.queryByText('ALREADY ENCODED')).toBeNull();
  });

  it('renders N proposed upgrades when expanded', () => {
    const p = pattern({
      proposedUpgrades: [
        upgrade({ targetPath: '~/.claude/CLAUDE.md' }),
        upgrade({ target: 'project-claude-md', targetPath: '<repo>/CLAUDE.md' }),
        upgrade({ target: 'skill', targetPath: '~/.claude/skills/foo/SKILL.md' }),
      ],
    });
    render(<CorrectionPatternCard pattern={p} instancesById={buildInstancesById(p.instanceIds)} />);
    fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
    expect(screen.getAllByText('COPY PATCH')).toHaveLength(3);
    expect(screen.getByText('GLOBAL CLAUDE.MD')).toBeDefined();
    expect(screen.getByText('PROJECT CLAUDE.MD')).toBeDefined();
    expect(screen.getByText('SKILL')).toBeDefined();
  });

  describe('clipboard + apply behavior', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
        writable: true,
      });
    });

    it('writes the patch text to the clipboard when COPY PATCH is clicked', async () => {
      const p = pattern({
        proposedUpgrades: [upgrade({ patch: '- Do not add docstrings unless asked.' })],
      });
      render(
        <CorrectionPatternCard pattern={p} instancesById={buildInstancesById(p.instanceIds)} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      fireEvent.click(screen.getByRole('button', { name: /COPY PATCH/i }));
      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          '- Do not add docstrings unless asked.',
        );
      });
    });

    it('renders APPLY as disabled with an explanatory tooltip', () => {
      const p = pattern();
      render(
        <CorrectionPatternCard pattern={p} instancesById={buildInstancesById(p.instanceIds)} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      const apply = screen.getByRole('button', { name: /^APPLY$/ });
      expect((apply as HTMLButtonElement).disabled).toBe(true);
      expect(apply.getAttribute('title')).toMatch(/not yet implemented/i);
    });
  });
});
