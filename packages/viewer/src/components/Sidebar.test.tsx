import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Sidebar } from './Sidebar.js';

afterEach(() => cleanup());

describe('Sidebar (vertical variant, default)', () => {
  it('renders the four top-level mode buttons (DETAIL is not a sidebar destination)', () => {
    render(<Sidebar mode="command" onSelectMode={() => {}} />);
    expect(screen.getByRole('button', { name: /mode COMMAND/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode TIMELINE/i })).toBeDefined();
    // CONSTELLATION mode renders under the "ANALYSIS" label in the sidebar;
    // the internal id stays `constellation` for code stability.
    expect(screen.getByRole('button', { name: /mode ANALYSIS/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode COST/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /mode DETAIL/i })).toBeNull();
  });

  it('groups the nav into BROWSE and INSIGHTS sections (no DATA without onOpenDataPanel)', () => {
    const { container } = render(<Sidebar mode="command" onSelectMode={() => {}} />);
    const labels = container.querySelectorAll('.lcars-sidebar__group-label');
    expect(Array.from(labels).map((el) => el.textContent)).toEqual(['BROWSE', 'INSIGHTS']);
  });

  it('marks the active mode with aria-current=page', () => {
    render(<Sidebar mode="timeline" onSelectMode={() => {}} />);
    const active = screen.getByRole('button', { name: /mode TIMELINE/i });
    expect(active.getAttribute('aria-current')).toBe('page');
    const inactive = screen.getByRole('button', { name: /mode COMMAND/i });
    expect(inactive.getAttribute('aria-current')).toBeNull();
  });

  it('applies the --active class only to the active item', () => {
    render(<Sidebar mode="constellation" onSelectMode={() => {}} />);
    const active = screen.getByRole('button', { name: /mode ANALYSIS/i });
    const inactive = screen.getByRole('button', { name: /mode COMMAND/i });
    expect(active.className).toContain('lcars-sidebar__item--active');
    expect(inactive.className).not.toContain('lcars-sidebar__item--active');
  });

  it('invokes onSelectMode on click', () => {
    const onSelectMode = vi.fn();
    render(<Sidebar mode="command" onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByRole('button', { name: /mode TIMELINE/i }));
    expect(onSelectMode).toHaveBeenCalledWith('timeline');
  });

  it('invokes onSelectMode on Enter key', () => {
    const onSelectMode = vi.fn();
    render(<Sidebar mode="command" onSelectMode={onSelectMode} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /mode COST/i }), { key: 'Enter' });
    expect(onSelectMode).toHaveBeenCalledWith('cost');
  });

  it('renders the v2 single-L chrome (one element, not two)', () => {
    // Spec §10: single L-shape, left-edge-only frame. The v1 two-rectangle
    // pair (`__elbow--top` + `__elbow--bottom`) is retired.
    const { container } = render(<Sidebar mode="command" onSelectMode={() => {}} />);
    expect(container.querySelectorAll('.lcars-sidebar__elbow').length).toBe(0);
    expect(container.querySelectorAll('.lcars-sidebar__l-frame').length).toBe(1);
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
  it('renders a pill bar without chrome frame, DETAIL dropped', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} variant="horizontal" />,
    );
    expect(container.querySelector('.lcars-sidebar--horizontal')).toBeTruthy();
    expect(container.querySelectorAll('.lcars-sidebar__elbow').length).toBe(0);
    expect(container.querySelectorAll('.lcars-sidebar__l-frame').length).toBe(0);
    expect(container.querySelectorAll('.lcars-sidebar__pill').length).toBe(4);
  });

  it('shows only the short label in horizontal pills', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} variant="horizontal" />,
    );
    const pillShorts = container.querySelectorAll('.lcars-sidebar__pill-short');
    expect(pillShorts.length).toBe(4);
    const texts = Array.from(pillShorts).map((el) => el.textContent);
    expect(texts).toEqual(['CMD', 'TIM', 'ANL', 'CST']);
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
      'CMD',
      'TIM',
      'ANL',
      'CST',
      'DAT',
    ]);
    fireEvent.click(screen.getByRole('button', { name: /open DATA panel/i }));
    expect(onOpenDataPanel).toHaveBeenCalledTimes(1);
  });

  it('marks the active pill', () => {
    render(<Sidebar mode="timeline" onSelectMode={() => {}} variant="horizontal" />);
    const active = screen.getByRole('button', { name: /mode TIMELINE/i });
    expect(active.className).toContain('lcars-sidebar__pill--active');
    const inactive = screen.getByRole('button', { name: /mode COMMAND/i });
    expect(inactive.className).not.toContain('lcars-sidebar__pill--active');
  });

  it('invokes onSelectMode on click in horizontal variant', () => {
    const onSelectMode = vi.fn();
    render(<Sidebar mode="command" onSelectMode={onSelectMode} variant="horizontal" />);
    fireEvent.click(screen.getByRole('button', { name: /mode ANALYSIS/i }));
    expect(onSelectMode).toHaveBeenCalledWith('constellation');
  });
});
