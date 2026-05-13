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

  describe('upgrade headline (lead-with-the-punchline)', () => {
    it('renders the upgrade.headline above the rationale when present', () => {
      const u = upgrade({
        headline: "Widen 'adversarial review' rule to fire on plans, not just experiment results.",
      });
      const p = pattern({ proposedUpgrades: [u] });
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded
        />,
      );
      expect(
        screen.getByText(
          "Widen 'adversarial review' rule to fire on plans, not just experiment results.",
        ),
      ).toBeDefined();
    });

    it('falls back to a derived headline from rationale when the field is missing', () => {
      // Legacy data path: corrections.json written before the headline
      // field shipped. The card must still lead with a one-liner;
      // long rationale alone is the bug the headline solves.
      const u = upgrade({
        rationale:
          'Rule recurs in 5 sessions and 3 projects. Diagnose the trigger before reword.',
      });
      const p = pattern({ proposedUpgrades: [u] });
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded
        />,
      );
      // First sentence (12 words, ≤15 cap — no truncation).
      expect(
        screen.getByText('Rule recurs in 5 sessions and 3 projects.'),
      ).toBeDefined();
    });

    it('truncates a fallback headline to ~15 words with an ellipsis', () => {
      const u = upgrade({
        rationale:
          'This is a deliberately long single sentence that runs well past fifteen words to verify the truncation branch kicks in and appends an ellipsis at the end',
      });
      const p = pattern({ proposedUpgrades: [u] });
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded
        />,
      );
      // The first 15 words + ellipsis. Asserting on the ellipsis is
      // enough; counting exact words is brittle.
      const headlineText = screen.getByText(
        /^This is a deliberately long single sentence that runs well past fifteen words to verify…$/,
      );
      expect(headlineText).toBeDefined();
    });
  });

  describe('section ordering (proposals before evidence)', () => {
    it('renders PROPOSED UPGRADES above EVIDENCE in the DOM', () => {
      const p = pattern();
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded
        />,
      );
      const proposals = screen.getByText('PROPOSED UPGRADES');
      const evidence = screen.getByText('EVIDENCE');
      // Both labels are in the document; compareDocumentPosition
      // returns DOCUMENT_POSITION_FOLLOWING (4) when `evidence` follows
      // `proposals`. Anything else means we regressed the ordering.
      expect(
        proposals.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('collapses EVIDENCE by default — instance bodies are hidden until the user opens them', () => {
      const p = pattern();
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded
        />,
      );
      // Header is visible; the conversation excerpts inside are not.
      expect(screen.getByText('EVIDENCE')).toBeDefined();
      expect(screen.queryByText(/please c1 stop using docstrings/)).toBeNull();
    });

    it('opens EVIDENCE when the toggle is clicked', () => {
      const p = pattern();
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /EVIDENCE/ }));
      expect(screen.getByText(/please c1 stop using docstrings/)).toBeDefined();
    });

    // a11y: PROPOSED UPGRADES is an <h4>, so EVIDENCE must announce as
    // a heading at the same level — otherwise screen-reader heading-
    // list navigation walks past it. The toggle button uses
    // aria-expanded + aria-controls to pair with the disclosure region.
    it('exposes EVIDENCE label as a level-4 heading paired to its region', () => {
      const p = pattern();
      const { container } = render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded
        />,
      );
      const toggle = screen.getByRole('button', { name: /EVIDENCE/ });
      const controlsId = toggle.getAttribute('aria-controls');
      expect(controlsId).toBeTruthy();
      // PROPOSED UPGRADES is a real <h4> — pin heading-level parity.
      const proposalsHeading = screen.getByText('PROPOSED UPGRADES');
      expect(proposalsHeading.tagName).toBe('H4');
      // EVIDENCE span needs role=heading aria-level=4 to match in the
      // SR heading list.
      const evidenceLabel = screen.getByText('EVIDENCE');
      expect(evidenceLabel.getAttribute('role')).toBe('heading');
      expect(evidenceLabel.getAttribute('aria-level')).toBe('4');
      // Region is mounted only after open — click and verify pairing.
      fireEvent.click(toggle);
      const region = container.querySelector(`#${controlsId}`);
      expect(region).not.toBeNull();
      expect(region?.getAttribute('role')).toBe('region');
    });
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

  describe('defaultExpanded (P0.3 review fix)', () => {
    it('auto-expands when defaultExpanded is true', () => {
      const p = pattern({
        proposedUpgrades: [upgrade()],
      });
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded
        />,
      );
      // Body content (PROPOSED UPGRADES section + COPY PATCH) is only
      // present when expanded — assert it's already visible without
      // clicking SHOW DETAILS.
      expect(screen.getByText('PROPOSED UPGRADES')).toBeDefined();
      expect(screen.getByRole('button', { name: /COPY PATCH/i })).toBeDefined();
      // Toggle label flips to HIDE DETAILS.
      expect(
        screen.getByRole('button', { name: /HIDE DETAILS/i }),
      ).toBeDefined();
    });

    it('starts collapsed when defaultExpanded is false (default)', () => {
      const p = pattern({ proposedUpgrades: [upgrade()] });
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
        />,
      );
      expect(screen.queryByText('PROPOSED UPGRADES')).toBeNull();
      expect(
        screen.getByRole('button', { name: /SHOW DETAILS/i }),
      ).toBeDefined();
    });

    it('flipping defaultExpanded false→true expands a previously collapsed card', () => {
      const p = pattern({ proposedUpgrades: [upgrade()] });
      const { rerender } = render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded={false}
        />,
      );
      expect(screen.queryByText('PROPOSED UPGRADES')).toBeNull();
      rerender(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          defaultExpanded
        />,
      );
      expect(screen.getByText('PROPOSED UPGRADES')).toBeDefined();
    });
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

    it('renders APPLY as disabled when no onApply handler is provided', () => {
      // Production static-build fallback: APPLY stays disabled with a
      // copy-and-edit tooltip so users can still apply manually.
      const p = pattern();
      render(
        <CorrectionPatternCard pattern={p} instancesById={buildInstancesById(p.instanceIds)} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      const apply = screen.getByRole('button', { name: /^APPLY$/ });
      expect((apply as HTMLButtonElement).disabled).toBe(true);
      expect(apply.getAttribute('title')).toMatch(/copy/i);
    });
  });

  describe('apply state machine', () => {
    it('renders APPLY as enabled when an onApply handler is provided', () => {
      const onApply = vi.fn();
      const p = pattern();
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          onApply={onApply}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      const apply = screen.getByRole('button', { name: /^APPLY$/ });
      expect((apply as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows the confirm row after the first APPLY click', () => {
      const onApply = vi.fn();
      const p = pattern();
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          onApply={onApply}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      fireEvent.click(screen.getByRole('button', { name: /^APPLY$/ }));
      // onApply is NOT called yet — only after CONFIRM APPLY.
      expect(onApply).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /CONFIRM APPLY/i })).toBeDefined();
      expect(screen.getByRole('button', { name: /CANCEL/i })).toBeDefined();
    });

    it('passes the proposed-upgrade payload (with extras) when CONFIRM APPLY is clicked', async () => {
      const onApply = vi.fn().mockResolvedValue({ ok: true });
      const u = upgrade({ targetPath: '~/.claude/CLAUDE.md', patch: '- rule X' });
      const p = pattern({ proposedUpgrades: [u] });
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          onApply={onApply}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      fireEvent.click(screen.getByRole('button', { name: /^APPLY$/ }));
      // Type into the optional fields to confirm they thread through.
      const textareas = screen.getAllByRole('textbox');
      fireEvent.change(textareas[0], {
        target: { value: '~/.claude/CLAUDE.md\n<repo>/CLAUDE.md' },
      });
      fireEvent.change(textareas[1], { target: { value: 'moved to PostToolUse' } });
      fireEvent.click(screen.getByRole('button', { name: /CONFIRM APPLY/i }));
      await waitFor(() => {
        expect(onApply).toHaveBeenCalledTimes(1);
      });
      expect(onApply).toHaveBeenCalledWith(u, {
        targetFiles: ['~/.claude/CLAUDE.md', '<repo>/CLAUDE.md'],
        notes: 'moved to PostToolUse',
      });
    });

    it('swaps to APPLIED ✓ on success', async () => {
      const onApply = vi.fn().mockResolvedValue({ ok: true });
      const p = pattern();
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          onApply={onApply}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      fireEvent.click(screen.getByRole('button', { name: /^APPLY$/ }));
      fireEvent.click(screen.getByRole('button', { name: /CONFIRM APPLY/i }));
      await waitFor(() => {
        expect(screen.getByText(/APPLIED ✓/)).toBeDefined();
      });
      // The APPLY button is gone now — replaced by the APPLIED ✓ pill.
      expect(screen.queryByRole('button', { name: /^APPLY$/ })).toBeNull();
    });

    it('shows an inline error + RETRY when onApply returns ok: false', async () => {
      const onApply = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'disk full' });
      const p = pattern();
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          onApply={onApply}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      fireEvent.click(screen.getByRole('button', { name: /^APPLY$/ }));
      fireEvent.click(screen.getByRole('button', { name: /CONFIRM APPLY/i }));
      await waitFor(() => {
        expect(screen.getByText(/Apply failed: disk full/)).toBeDefined();
      });
      // RETRY pulls the user back into the confirm step rather than throwing.
      const retry = screen.getByRole('button', { name: /RETRY/i });
      expect(retry).toBeDefined();
      fireEvent.click(retry);
      expect(screen.getByRole('button', { name: /CONFIRM APPLY/i })).toBeDefined();
    });

    it('renders APPLIED ✓ on initial render when the upgrade is already applied', () => {
      // Mirrors the case where mergeAppliedImprovements stamped applied
      // = true onto a ProposedUpgrade before the card mounts (page
      // reload after a previous APPLY).
      const u = upgrade({ applied: true, appliedAt: 1_700_500_000_000 });
      const p = pattern({ proposedUpgrades: [u] });
      const onApply = vi.fn();
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          onApply={onApply}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      expect(screen.getByText(/APPLIED ✓/)).toBeDefined();
    });
  });

  describe('instance clickthrough', () => {
    it('renders each instance as a clickable button when onSelectSession is provided', () => {
      const onSelectSession = vi.fn();
      const p = pattern();
      render(
        <CorrectionPatternCard
          pattern={p}
          instancesById={buildInstancesById(p.instanceIds)}
          onSelectSession={onSelectSession}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      // Evidence is collapsed by default after the proposals-first
      // reordering; open it before asserting on the instance pills.
      fireEvent.click(screen.getByRole('button', { name: /EVIDENCE/ }));
      // 3 instances × 1 pill each.
      const pills = screen.getAllByRole('button', { name: /open session s-c/ });
      expect(pills).toHaveLength(3);
      fireEvent.click(pills[0]);
      expect(onSelectSession).toHaveBeenCalledWith('s-c1');
    });

    it('renders instances as static (no buttons) when onSelectSession is omitted', () => {
      const p = pattern();
      render(
        <CorrectionPatternCard pattern={p} instancesById={buildInstancesById(p.instanceIds)} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /SHOW DETAILS/i }));
      fireEvent.click(screen.getByRole('button', { name: /EVIDENCE/ }));
      // Only the SHOW/HIDE-DETAILS toggle, EVIDENCE toggle, and
      // (disabled) APPLY remain as buttons in this branch — no
      // per-instance pill buttons.
      expect(screen.queryAllByRole('button', { name: /open session/i })).toHaveLength(0);
    });
  });
});
