// Tests for the Rev3-B B9 BlurredPii component — default-blur
// narrative-preview text with a reveal-on-click affordance.

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { BlurredPii } from './BlurredPii.js';

describe('BlurredPii (Rev3-B B9 — default-blur PII previews)', () => {
  it('renders blurred-by-default with the content present in the DOM (screen-reader navigable)', () => {
    const { container } = render(<BlurredPii>sensitive narrative title</BlurredPii>);
    // Underlying text is still in the DOM — required for screen-reader navigation
    // even when visually blurred. The blur is a CSS effect, not content removal.
    expect(container.textContent).toContain('sensitive narrative title');
    // Wrapper carries the blurred-state class so the CSS rule fires.
    const wrapper = container.querySelector('.blurred-pii');
    expect(wrapper?.classList.contains('blurred-pii--blurred')).toBe(true);
    expect(wrapper?.classList.contains('blurred-pii--revealed')).toBe(false);
  });

  it('content is aria-hidden when blurred (screen-readers see the announcement instead)', () => {
    const { container } = render(<BlurredPii>secret</BlurredPii>);
    const content = container.querySelector('.blurred-pii__content');
    expect(content?.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes a Reveal button labeled with the field name', () => {
    render(<BlurredPii label="narrative title">secret</BlurredPii>);
    const button = screen.getByRole('button', { name: /reveal narrative title/i });
    expect(button).toBeDefined();
    expect(button.getAttribute('aria-label')).toContain('PII-blurred by default');
  });

  it('clicking Reveal flips to revealed state — content visible + Hide button shown', () => {
    const { container } = render(
      <BlurredPii label="narrative body">whoops sensitive prose</BlurredPii>,
    );
    const reveal = screen.getByRole('button', { name: /reveal narrative body/i });
    fireEvent.click(reveal);

    // Wrapper now carries the revealed-state class.
    const wrapper = container.querySelector('.blurred-pii');
    expect(wrapper?.classList.contains('blurred-pii--revealed')).toBe(true);
    expect(wrapper?.classList.contains('blurred-pii--blurred')).toBe(false);

    // Content is no longer aria-hidden.
    const content = container.querySelector('.blurred-pii__content');
    expect(content?.getAttribute('aria-hidden')).toBeNull();

    // Reveal button gone, Hide button present.
    expect(screen.queryByRole('button', { name: /reveal narrative body/i })).toBeNull();
    const hide = screen.getByRole('button', { name: /re-blur narrative body/i });
    expect(hide).toBeDefined();
  });

  it('clicking Hide on a revealed instance flips back to blurred', () => {
    const { container } = render(
      <BlurredPii label="narrative body" initialRevealed>
        prose
      </BlurredPii>,
    );
    const hide = screen.getByRole('button', { name: /re-blur narrative body/i });
    fireEvent.click(hide);
    const wrapper = container.querySelector('.blurred-pii');
    expect(wrapper?.classList.contains('blurred-pii--blurred')).toBe(true);
    expect(screen.getByRole('button', { name: /reveal narrative body/i })).toBeDefined();
  });

  it('default label is "PII content" when not provided', () => {
    render(<BlurredPii>secret</BlurredPii>);
    expect(
      screen.getByRole('button', { name: /reveal PII content/i }),
    ).toBeDefined();
  });

  it('initialRevealed=true (test hook) shows revealed state from the start', () => {
    const { container } = render(
      <BlurredPii initialRevealed>open from start</BlurredPii>,
    );
    expect(
      container.querySelector('.blurred-pii')?.classList.contains('blurred-pii--revealed'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: /re-blur/i })).toBeDefined();
  });

  it('preserves extra className applied by the caller', () => {
    const { container } = render(
      <BlurredPii className="lcars-pii">x</BlurredPii>,
    );
    const wrapper = container.querySelector('.blurred-pii');
    expect(wrapper?.classList.contains('lcars-pii')).toBe(true);
  });

  it('includes a screen-reader-only state announcement', () => {
    const { container } = render(<BlurredPii label="narrative title">x</BlurredPii>);
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly?.textContent).toContain('narrative title');
    expect(srOnly?.textContent).toContain('PII-blurred');
  });
});
