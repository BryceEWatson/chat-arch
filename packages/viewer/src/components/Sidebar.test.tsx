import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Sidebar } from './Sidebar.js';

afterEach(() => cleanup());

describe('Sidebar (vertical variant, default) — Phase 2a IA', () => {
  it('renders FIX RULES (CORRECTIONS+PRACTICE), BROWSE (SESSIONS), ANALYTICS (PROJECTS+TOPICS+COST)', () => {
    render(<Sidebar mode="command" onSelectMode={() => {}} />);
    // FIX RULES — primary refocus surfaces lead.
    expect(screen.getByRole('button', { name: /mode CORRECTIONS/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode PRACTICE/i })).toBeDefined();
    // BROWSE — sessions only.
    expect(screen.getByRole('button', { name: /mode SESSIONS/i })).toBeDefined();
    // ANALYTICS — descriptive surfaces.
    expect(screen.getByRole('button', { name: /mode PROJECTS/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode TOPICS/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode COST/i })).toBeDefined();
    // Absent — Phase 3 cut ANALYSIS/constellation entirely.
    expect(screen.queryByRole('button', { name: /mode ANALYSIS/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /mode TIMELINE/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /mode DETAIL/i })).toBeNull();
  });

  it('groups the nav into FIX RULES, BROWSE, ANALYTICS sections', () => {
    const { container } = render(<Sidebar mode="command" onSelectMode={() => {}} />);
    const labels = container.querySelectorAll('.lcars-sidebar__group-label');
    expect(Array.from(labels).map((el) => el.textContent)).toEqual([
      'FIX RULES',
      'BROWSE',
      'ANALYTICS',
    ]);
  });

  it('marks the active mode with aria-current=page', () => {
    render(<Sidebar mode="command" onSelectMode={() => {}} />);
    const active = screen.getByRole('button', { name: /mode SESSIONS/i });
    expect(active.getAttribute('aria-current')).toBe('page');
    const inactive = screen.getByRole('button', { name: /mode COST/i });
    expect(inactive.getAttribute('aria-current')).toBeNull();
  });

  it('applies the --active class only to the active item', () => {
    render(<Sidebar mode="cost" onSelectMode={() => {}} />);
    const active = screen.getByRole('button', { name: /mode COST/i });
    const inactive = screen.getByRole('button', { name: /mode SESSIONS/i });
    expect(active.className).toContain('lcars-sidebar__item--active');
    expect(inactive.className).not.toContain('lcars-sidebar__item--active');
  });

  it('invokes onSelectMode on click', () => {
    const onSelectMode = vi.fn();
    render(<Sidebar mode="command" onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByRole('button', { name: /mode COST/i }));
    expect(onSelectMode).toHaveBeenCalledWith('cost');
  });

  it('invokes onSelectMode on Enter key', () => {
    const onSelectMode = vi.fn();
    render(<Sidebar mode="command" onSelectMode={onSelectMode} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /mode COST/i }), { key: 'Enter' });
    expect(onSelectMode).toHaveBeenCalledWith('cost');
  });

  it('renders only the top elbow (left-edge-only frame, no bottom elbow)', () => {
    const { container } = render(<Sidebar mode="command" onSelectMode={() => {}} />);
    expect(container.querySelectorAll('.lcars-sidebar__elbow--top').length).toBe(1);
    expect(container.querySelectorAll('.lcars-sidebar__elbow--bottom').length).toBe(0);
    expect(container.querySelectorAll('.lcars-sidebar__l-frame').length).toBe(0);
  });
});

describe('Sidebar — ANALYTICS collapse (Phase 2a)', () => {
  it('hides the analytics list when analyticsCollapsed=true', () => {
    const { container } = render(
      <Sidebar
        mode="command"
        onSelectMode={() => {}}
        analyticsCollapsed
        onToggleAnalyticsCollapsed={() => {}}
      />,
    );
    const groups = container.querySelectorAll('.lcars-sidebar__group');
    // ANALYTICS is the third group (FIX RULES, BROWSE, ANALYTICS).
    const analytics = groups[2];
    expect(analytics.classList.contains('lcars-sidebar__group--collapsed')).toBe(true);
  });

  it('marks the toggle label with aria-expanded=false when collapsed', () => {
    render(
      <Sidebar
        mode="command"
        onSelectMode={() => {}}
        analyticsCollapsed
        onToggleAnalyticsCollapsed={() => {}}
      />,
    );
    const toggle = screen.getByRole('button', { name: /expand ANALYTICS/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('marks the toggle label with aria-expanded=true when expanded', () => {
    render(
      <Sidebar
        mode="command"
        onSelectMode={() => {}}
        analyticsCollapsed={false}
        onToggleAnalyticsCollapsed={() => {}}
      />,
    );
    const toggle = screen.getByRole('button', { name: /collapse ANALYTICS/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('invokes onToggleAnalyticsCollapsed on click', () => {
    const onToggle = vi.fn();
    render(
      <Sidebar
        mode="command"
        onSelectMode={() => {}}
        analyticsCollapsed
        onToggleAnalyticsCollapsed={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /expand ANALYTICS/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('invokes onToggleAnalyticsCollapsed on Enter key', () => {
    const onToggle = vi.fn();
    render(
      <Sidebar
        mode="command"
        onSelectMode={() => {}}
        analyticsCollapsed
        onToggleAnalyticsCollapsed={onToggle}
      />,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: /expand ANALYTICS/i }), {
      key: 'Enter',
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders ANALYTICS label as static (non-button) when no toggle handler is provided', () => {
    // Falls back to plain label when host doesn't supply a toggle —
    // safety for embeddings that don't manage collapse state.
    const { container } = render(<Sidebar mode="command" onSelectMode={() => {}} />);
    const labels = container.querySelectorAll('.lcars-sidebar__group-label');
    const analyticsLabel = labels[2];
    expect(analyticsLabel.getAttribute('role')).toBeNull();
    expect(analyticsLabel.textContent).toBe('ANALYTICS');
  });
});

describe('Sidebar — DATA panel trigger (v2 spec §6 / D4)', () => {
  it('renders the DATA item under an ACTIONS group when onOpenDataPanel is provided', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} onOpenDataPanel={() => {}} />,
    );
    const labels = container.querySelectorAll('.lcars-sidebar__group-label');
    expect(Array.from(labels).map((el) => el.textContent)).toEqual([
      'FIX RULES',
      'BROWSE',
      'ANALYTICS',
      'ACTIONS',
    ]);
    expect(screen.getByRole('button', { name: /open DATA panel/i })).toBeDefined();
  });

  it('invokes onOpenDataPanel on click', () => {
    const onOpenDataPanel = vi.fn();
    render(
      <Sidebar mode="command" onSelectMode={() => {}} onOpenDataPanel={onOpenDataPanel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /open DATA panel/i }));
    expect(onOpenDataPanel).toHaveBeenCalledTimes(1);
  });

  it('reflects open state via aria-pressed', () => {
    const { rerender } = render(
      <Sidebar
        mode="command"
        onSelectMode={() => {}}
        onOpenDataPanel={() => {}}
        dataPanelOpen={false}
      />,
    );
    let btn = screen.getByRole('button', { name: /open DATA panel/i });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    rerender(
      <Sidebar
        mode="command"
        onSelectMode={() => {}}
        onOpenDataPanel={() => {}}
        dataPanelOpen={true}
      />,
    );
    btn = screen.getByRole('button', { name: /open DATA panel/i });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toContain('lcars-sidebar__item--active');
  });
});

describe('Sidebar (horizontal variant)', () => {
  it('renders a pill bar without chrome frame, in the Phase 2a refocus order', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} variant="horizontal" />,
    );
    expect(container.querySelector('.lcars-sidebar--horizontal')).toBeTruthy();
    expect(container.querySelectorAll('.lcars-sidebar__elbow').length).toBe(0);
    // 6 mode pills (Phase 3 cut ANL/constellation): COR, PRC, SES, PRJ, TOP, CST.
    expect(container.querySelectorAll('.lcars-sidebar__pill').length).toBe(6);
  });

  it('shows only the short label in horizontal pills, in the new order', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} variant="horizontal" />,
    );
    const pillShorts = container.querySelectorAll('.lcars-sidebar__pill-short');
    expect(pillShorts.length).toBe(6);
    const texts = Array.from(pillShorts).map((el) => el.textContent);
    expect(texts).toEqual(['COR', 'PRC', 'SES', 'PRJ', 'TOP', 'CST']);
  });

  it('appends a DAT pill when onOpenDataPanel is provided', () => {
    const onOpenDataPanel = vi.fn();
    const { container } = render(
      <Sidebar
        mode="command"
        onSelectMode={() => {}}
        onOpenDataPanel={onOpenDataPanel}
        variant="horizontal"
      />,
    );
    const pillShorts = container.querySelectorAll('.lcars-sidebar__pill-short');
    expect(Array.from(pillShorts).map((el) => el.textContent)).toEqual([
      'COR',
      'PRC',
      'SES',
      'PRJ',
      'TOP',
      'CST',
      'DAT',
    ]);
    fireEvent.click(screen.getByRole('button', { name: /open DATA panel/i }));
    expect(onOpenDataPanel).toHaveBeenCalledTimes(1);
  });

  it('marks the active pill', () => {
    render(<Sidebar mode="cost" onSelectMode={() => {}} variant="horizontal" />);
    const active = screen.getByRole('button', { name: /mode COST/i });
    expect(active.className).toContain('lcars-sidebar__pill--active');
    const inactive = screen.getByRole('button', { name: /mode SESSIONS/i });
    expect(inactive.className).not.toContain('lcars-sidebar__pill--active');
  });

  it('invokes onSelectMode on click in horizontal variant', () => {
    const onSelectMode = vi.fn();
    render(<Sidebar mode="command" onSelectMode={onSelectMode} variant="horizontal" />);
    fireEvent.click(screen.getByRole('button', { name: /mode COST/i }));
    expect(onSelectMode).toHaveBeenCalledWith('cost');
  });

  it('keeps all 6 pills visible regardless of analyticsCollapsed (collapse is vertical-only)', () => {
    const { container } = render(
      <Sidebar
        mode="command"
        onSelectMode={() => {}}
        variant="horizontal"
        analyticsCollapsed
        onToggleAnalyticsCollapsed={() => {}}
      />,
    );
    expect(container.querySelectorAll('.lcars-sidebar__pill').length).toBe(6);
  });
});
