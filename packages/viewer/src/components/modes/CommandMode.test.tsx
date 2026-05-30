import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { CommandMode } from './CommandMode.js';

function entry(
  id: string,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cli-direct',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: `T ${id}`,
    titleSource: 'first-prompt',
    preview: 'preview body',
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

describe('CommandMode collapse of automated sessions', () => {
  it('renders the empty state when there are no sessions', () => {
    render(<CommandMode sessions={[]} onSelect={() => {}} />);
    expect(screen.getByText('NO MATCHES')).toBeDefined();
  });

  it('collapses N automated runs of one template into a single card with ×N badge', () => {
    const sessions = [
      entry('a1', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: 0.1 }),
      entry('a2', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: 0.2 }),
      entry('a3', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: 0.3 }),
    ];
    render(<CommandMode sessions={sessions} onSelect={() => {}} />);
    // One collapsed card, not three.
    const cards = document.querySelectorAll('.lcars-session-card--automated');
    expect(cards.length).toBe(1);
    // Template label + AUTOMATED tag + ×3 badge + aggregate cost.
    expect(screen.getByText('Project status paragraph')).toBeDefined();
    expect(screen.getByText('AUTOMATED')).toBeDefined();
    expect(screen.getByText('×3')).toBeDefined();
    expect(screen.getByText('$0.60')).toBeDefined();
  });

  it('renders interactive sessions one card each, unchanged', () => {
    const sessions = [entry('h1', { project: 'p' }), entry('h2', { project: 'p' })];
    render(<CommandMode sessions={sessions} onSelect={() => {}} />);
    expect(document.querySelectorAll('.lcars-session-card--automated').length).toBe(0);
    // Two normal session cards.
    expect(document.querySelectorAll('.lcars-session-card').length).toBe(2);
  });

  it('opens the representative member when the collapsed card is clicked', () => {
    const onSelect = vi.fn();
    const sessions = [
      entry('older', {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
        updatedAt: 1,
      }),
      entry('newest', {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
        updatedAt: 9,
      }),
    ];
    render(<CommandMode sessions={sessions} onSelect={onSelect} />);
    fireEvent.click(document.querySelector('.lcars-session-card--automated')!);
    // Representative is the most-recently-updated member.
    expect(onSelect).toHaveBeenCalledWith('newest');
  });
});
