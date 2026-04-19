import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Sidebar } from './Sidebar.js';

afterEach(() => cleanup());

describe('Sidebar (vertical variant, default)', () => {
  it('renders all 5 mode buttons with full labels', () => {
    render(<Sidebar mode="command" onSelectMode={() => {}} />);
    expect(screen.getByRole('button', { name: /mode COMMAND/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode TIMELINE/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode DETAIL/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode CONSTELLATION/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /mode COST/i })).toBeDefined();
  });

  it('marks the active mode with aria-current=page', () => {
    render(<Sidebar mode="timeline" onSelectMode={() => {}} />);
    const active = screen.getByRole('button', { name: /mode TIMELINE/i });
    expect(active.getAttribute('aria-current')).toBe('page');
    const inactive = screen.getByRole('button', { name: /mode COMMAND/i });
    expect(inactive.getAttribute('aria-current')).toBeNull();
  });

  it('applies the --active class only to the active item', () => {
    render(<Sidebar mode="detail" onSelectMode={() => {}} />);
    const active = screen.getByRole('button', { name: /mode DETAIL/i });
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

  it('renders the double-elbow chrome divs', () => {
    const { container } = render(<Sidebar mode="command" onSelectMode={() => {}} />);
    expect(container.querySelectorAll('.lcars-sidebar__elbow').length).toBe(2);
  });
});

describe('Sidebar (horizontal variant)', () => {
  it('renders a pill bar without elbows', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} variant="horizontal" />,
    );
    expect(container.querySelector('.lcars-sidebar--horizontal')).toBeTruthy();
    expect(container.querySelectorAll('.lcars-sidebar__elbow').length).toBe(0);
    expect(container.querySelectorAll('.lcars-sidebar__pill').length).toBe(5);
  });

  it('shows only the short label in horizontal pills', () => {
    const { container } = render(
      <Sidebar mode="command" onSelectMode={() => {}} variant="horizontal" />,
    );
    const pillShorts = container.querySelectorAll('.lcars-sidebar__pill-short');
    expect(pillShorts.length).toBe(5);
    const texts = Array.from(pillShorts).map((el) => el.textContent);
    expect(texts).toEqual(['CMD', 'TIM', 'DET', 'CON', 'CST']);
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
    fireEvent.click(screen.getByRole('button', { name: /mode DETAIL/i }));
    expect(onSelectMode).toHaveBeenCalledWith('detail');
  });
});
