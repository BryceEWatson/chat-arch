import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  CopyMarkdownButton,
  COPY_MARKDOWN_FOOTER,
  __test,
} from './CopyMarkdownButton.js';

/**
 * Wave 7 P1 #6 — CopyMarkdownButton contract:
 *   - Builds a markdown blockquote with title + body + methodology footer.
 *   - Uses navigator.clipboard.writeText when available.
 *   - Surfaces a "copied" indicator on success.
 *   - Surfaces a "failed" indicator when the clipboard API rejects.
 */

afterEach(() => cleanup());

describe('CopyMarkdownButton (markdown builder)', () => {
  it('formats the blockquote with title, lines, and the canonical methodology footer', () => {
    const md = __test.buildMarkdown('CONFIG IMPACT', [
      'Δ good-share: +12.0%',
      'n_pre=20, n_post=25',
    ]);
    expect(md).toMatch(/> \*\*CONFIG IMPACT\*\*/);
    expect(md).toMatch(/> Δ good-share: \+12\.0%/);
    expect(md).toMatch(/> n_pre=20, n_post=25/);
    expect(md).toContain(COPY_MARKDOWN_FOOTER);
    expect(md.startsWith('> ')).toBe(true);
  });

  it('preserves empty body lines as bare blockquote markers', () => {
    const md = __test.buildMarkdown('T', ['a', '', 'b']);
    const lines = md.split('\n');
    // After the header there's a blank-blockquote separator, then 'a', then blank, then 'b'.
    expect(lines).toContain('> a');
    expect(lines).toContain('>');
    expect(lines).toContain('> b');
  });
});

describe('CopyMarkdownButton (interaction)', () => {
  it('writes markdown to the clipboard and flips into the "copied" state', async () => {
    let copied: string | null = null;
    const originalClipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    });
    try {
      render(
        <CopyMarkdownButton
          title="CONFIG IMPACT"
          bodyLines={['n_pre=20', 'n_post=25']}
          testId="t"
        />,
      );
      const btn = screen.getByTestId('t');
      fireEvent.click(btn);
      await waitFor(() => expect(copied).not.toBeNull());
      expect(copied).toMatch(/CONFIG IMPACT/);
      expect(copied).toContain(COPY_MARKDOWN_FOOTER);
      await waitFor(() => expect(btn.getAttribute('data-state')).toBe('copied'));
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it('marks the button as "failed" when the clipboard rejects', async () => {
    const originalClipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    try {
      render(
        <CopyMarkdownButton title="X" bodyLines={['a']} testId="x" />,
      );
      fireEvent.click(screen.getByTestId('x'));
      await waitFor(() =>
        expect(screen.getByTestId('x').getAttribute('data-state')).toBe('failed'),
      );
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
});
