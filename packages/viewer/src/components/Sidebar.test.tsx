import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Sidebar } from './Sidebar.js';

afterEach(() => cleanup());

describe('Sidebar (vertical variant, default)', () => {
  it('renders PROJECTS + TOPICS + SESSIONS in BROWSE; PRACTICE + CORRECTIONS + ANALYSIS + COST in INSIGHTS', () => {
    render(<Sidebar mode="command" onSelectMode={() => {}} />);
    // BROWSE
    expect(screen.getByRole('button', { name: /mode PROJECTS/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode TOPICS/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode SESSIONS/i })).toBeDefined();
    // INSIGHTS — PRACTICE leads (D6b/D6c); CORRECTIONS sits between PRACTICE
    // and ANALYSIS so the "audit → suggest upgrades → deep-dive" flow reads
    // top-down.
    expect(screen.getByRole('button', { name: /mode PRACTICE/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode CORRECTIONS/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode ANALYSIS/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode COST/i })).toBeDefined();
    // Absent.
    expect(screen.queryByRole('button', { name: /mode TIMELINE/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /mode DETAIL/i })).toBeNull();
  });

  it('groups the nav into BROWSE and INSIGHTS sections (no DATA without onOpenDataPanel)', () => {
    const { container } = render(<Sidebar mode="command" onSelectMode={() => {}} />);
    const labels = container.querySelectorAll('.lcars-sidebar__group-label');
    expect(Array.from(labels).map((el) => el.textContent)).toEqual(['BROWSE', 'INSIGHTS']);
  });

  it('marks the active mode with aria-current=page', () => {
    render(<Sidebar mode="command" onSelectMode={() => {}} />);
    const active = screen.getByRole('button', { name: /mode SESSIONS/i });
    expect(active.getAttribute('aria-current')).toBe('page');
    const inactive = screen.getByRole('button', { name: /mode COST/i });
    expect(inactive.getAttribute('aria-current')).toBeNull();
  });

  it('applies the --active class only to the active item', () => {
    render(<Sidebar mode="constellation" onSelectMode={() => {}} />);
    const active = screen.getByRole('button', { name: /mode ANALYSIS/i });
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
    // Spec §10 (amended 2026-05-07): the canonical design-system shape
    // is the asymmetric one-corner-rounded rectangle (radius.elbow-lg);
    // v2 keeps only the top elbow — bottom elbow is retired so the
    // sidebar's lower edge stays bare. The earlier single-SVG concave-
    // arc Elbow component diverged from the design system and has been
    // removed.
    const { container } = render(<Sidebar mode="command" onSelectMode={() => {}} />);
    expect(container.querySelectorAll('.lcars-sidebar__elbow--top').length).toBe(1);
    expect(container.querySelectorAll('.lcars-sidebar__elbow--bottom').length).toBe(0);
    expect(container.querySelectorAll('.lcars-sidebar__l-frame').length).toBe(0);
  });
});

describe('Sidebar — DATA panel trigger (v2 spec §6 / D4)', () => {
  it('renders the DATA item under an ACTIONS group when onOpenDataPanel is provided', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} onOpenDataPanel={() => {}} />,
    );
    const labels = container.querySelectorAll('.lcars-sidebar__group-label');
    expect(Array.from(labels).map((el) => el.textContent)).toEqual([
      'BROWSE',
      'INSIGHTS',
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
  it('renders a pill bar without chrome frame, DETAIL + TIMELINE dropped', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} variant="horizontal" />,
    );
    expect(container.querySelector('.lcars-sidebar--horizontal')).toBeTruthy();
    expect(container.querySelectorAll('.lcars-sidebar__elbow').length).toBe(0);
    // 7 mode pills now: PRJ, TOP, SES, PRC, COR, ANL, CST.
    expect(container.querySelectorAll('.lcars-sidebar__pill').length).toBe(7);
  });

  it('shows only the short label in horizontal pills', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} variant="horizontal" />,
    );
    const pillShorts = container.querySelectorAll('.lcars-sidebar__pill-short');
    expect(pillShorts.length).toBe(7);
    const texts = Array.from(pillShorts).map((el) => el.textContent);
    expect(texts).toEqual(['PRJ', 'TOP', 'SES', 'PRC', 'COR', 'ANL', 'CST']);
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
      'PRJ',
      'TOP',
      'SES',
      'PRC',
      'COR',
      'ANL',
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
    fireEvent.click(screen.getByRole('button', { name: /mode ANALYSIS/i }));
    expect(onSelectMode).toHaveBeenCalledWith('constellation');
  });
});
