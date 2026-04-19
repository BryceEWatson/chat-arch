import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { CloudTextBlock } from '@chat-arch/schema';
import { ContentBlock } from './ContentBlock.js';

function textBlock(text: string): CloudTextBlock {
  return { type: 'text', text } as CloudTextBlock;
}

describe('ContentBlock — XSS regression on dangerouslySetInnerHTML', () => {
  it('script tags in transcript text never execute as <script> elements', () => {
    const { container } = render(
      <ContentBlock block={textBlock('hello <script>alert(1)</script> world')} />,
    );
    // No element with tagName SCRIPT should be present anywhere in the rendered tree.
    expect(container.querySelector('script')).toBeNull();
    // The angle brackets must have been HTML-escaped before being passed to
    // dangerouslySetInnerHTML, so the literal <script> markup is not present.
    expect(container.innerHTML).not.toContain('<script>');
    // jsdom serializes the escaped & < > back into the textContent unchanged,
    // but we verify the visible rendered text is the escaped tag form.
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('img onerror payload from transcript text is rendered as text, not as an img', () => {
    const payload = '<img src=x onerror="alert(1)">';
    const { container } = render(<ContentBlock block={textBlock(payload)} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('<img');
    expect(container.textContent).toContain(payload);
  });

  it('an event-handler attribute smuggled inside **bold** does not become a real attribute', () => {
    // Markdown is applied AFTER escaping. This pins that order so an attacker
    // cannot smuggle attributes through the bold rule. The literal text is
    // wrapped in a paragraph (not a heading) by including a trailing word so
    // the line does not match the `^**...**$` heading shape.
    const payload = 'paragraph **bold" onclick="alert(1)** tail';
    const { container } = render(<ContentBlock block={textBlock(payload)} />);
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    // The attacker quotes/onclick must not have parsed as a real DOM attribute.
    expect(strong?.getAttribute('onclick')).toBeNull();
    // The whole "bold" run survives as text inside the strong element.
    expect(strong?.textContent).toContain('onclick=');
  });

  it('angle brackets and ampersands in arbitrary text never reach the DOM as markup', () => {
    const { container } = render(<ContentBlock block={textBlock('5 < 6 && a > b')} />);
    // Nothing got parsed as a tag.
    expect(container.querySelector('b')).toBeNull();
    // The escaped form is still in the raw markup that React handed to the browser.
    expect(container.innerHTML).toContain('&lt;');
    expect(container.innerHTML).toContain('&amp;');
    // The rendered text shows the user's original characters.
    expect(container.textContent).toContain('5 < 6 && a > b');
  });
});
