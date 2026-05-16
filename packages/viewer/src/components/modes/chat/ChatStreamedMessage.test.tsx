import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ChatCitation } from '@chat-arch/schema';
import { ChatStreamedMessage } from './ChatStreamedMessage.js';

const NO_CITATIONS: readonly ChatCitation[] = [];

describe('ChatStreamedMessage — collapsible trust-artifact sections', () => {
  it('wraps `## Caveats` and following blocks in a collapsed <details>', () => {
    const text = [
      'Headline answer paragraph.',
      '',
      '## Caveats',
      '',
      'A caveat paragraph.',
      '',
      '- bullet inside caveats',
    ].join('\n');
    const { container } = render(
      <ChatStreamedMessage text={text} citations={NO_CITATIONS} variant="final" />,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    // Collapsed by default.
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('Caveats');
    // The caveat paragraph and bullet live inside the details body.
    expect(details?.textContent).toContain('A caveat paragraph');
    expect(details?.textContent).toContain('bullet inside caveats');
    // The H2 itself does not also render as a sibling — the summary
    // replaces it. (Otherwise the heading would appear twice.)
    expect(container.querySelectorAll('h2').length).toBe(0);
  });

  it('renders a non-trigger `## Heading` as a normal <h2>', () => {
    const text = ['## Findings', '', 'Body paragraph.'].join('\n');
    const { container } = render(
      <ChatStreamedMessage text={text} citations={NO_CITATIONS} variant="final" />,
    );
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Findings');
  });

  it('a second H2 closes the collapsible — it does not absorb the next section', () => {
    const text = [
      '## Caveats',
      '',
      'Caveat body.',
      '',
      '## Findings',
      '',
      'Findings body.',
    ].join('\n');
    const { container } = render(
      <ChatStreamedMessage text={text} citations={NO_CITATIONS} variant="final" />,
    );
    const details = container.querySelector('details');
    expect(details?.textContent).toContain('Caveat body');
    expect(details?.textContent).not.toContain('Findings body');
    expect(container.querySelector('h2')?.textContent).toBe('Findings');
  });

  it('matches the documented title set case-insensitively (caveats / methodology / risks / honest negatives)', () => {
    const titles = [
      'caveats',
      'CAVEATS',
      'Methodology',
      'Risks',
      'Honest negatives',
      'honest notes',
      'Calibration',
    ];
    for (const t of titles) {
      const { container } = render(
        <ChatStreamedMessage
          text={`## ${t}\n\nBody.`}
          citations={NO_CITATIONS}
          variant="final"
        />,
      );
      expect(container.querySelector('details')).not.toBeNull();
    }
  });
});

describe('ChatStreamedMessage — follow-up chips (`→ Question?` lines)', () => {
  it('renders consecutive `→ ` lines as a chip group, not paragraphs', () => {
    const text = [
      'Answer paragraph.',
      '',
      '→ Which one would you turn into a blog post first?',
      '→ What corrections has X surfaced?',
    ].join('\n');
    const { container } = render(
      <ChatStreamedMessage text={text} citations={NO_CITATIONS} variant="final" />,
    );
    const buttons = container.querySelectorAll('.lcars-chat-message__followup');
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.textContent).toContain('Which one would you turn into a blog post first?');
    expect(buttons[1]?.textContent).toContain('What corrections has X surfaced?');
  });

  it('fires onFollowUpClick with the question text (without the `→ ` prefix) when a chip is clicked', () => {
    const onFollowUpClick = vi.fn();
    const text = '→ Should I do X?';
    const { container } = render(
      <ChatStreamedMessage
        text={text}
        citations={NO_CITATIONS}
        onFollowUpClick={onFollowUpClick}
        variant="final"
      />,
    );
    const button = container.querySelector('.lcars-chat-message__followup') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onFollowUpClick).toHaveBeenCalledTimes(1);
    expect(onFollowUpClick).toHaveBeenCalledWith('Should I do X?');
  });

  it('disables the chip when no onFollowUpClick handler is passed', () => {
    const text = '→ Should I do X?';
    const { container } = render(
      <ChatStreamedMessage text={text} citations={NO_CITATIONS} variant="final" />,
    );
    const button = container.querySelector('.lcars-chat-message__followup') as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
  });

  it('a paragraph that does not start with `→ ` is unaffected', () => {
    const text = 'Just a paragraph with an arrow → in the middle.';
    const { container } = render(
      <ChatStreamedMessage text={text} citations={NO_CITATIONS} variant="final" />,
    );
    expect(container.querySelector('.lcars-chat-message__followup')).toBeNull();
    expect(container.querySelector('p')?.textContent).toContain('arrow → in the middle');
  });
});

describe('ChatStreamedMessage — interactions between new + existing renderers', () => {
  it('citation chips inside a collapsible section still render and remain clickable', () => {
    const text = [
      '## Methodology',
      '',
      'Cited [SID:11111111-2222-3333-4444-555555555555] inside the body.',
    ].join('\n');
    const onCitationClick = vi.fn();
    const citations: readonly ChatCitation[] = [
      { sessionId: '11111111-2222-3333-4444-555555555555', source: 'cowork' },
    ];
    const { container } = render(
      <ChatStreamedMessage
        text={text}
        citations={citations}
        onCitationClick={onCitationClick}
        variant="final"
      />,
    );
    const chip = container.querySelector('details .lcars-chat-citation') as HTMLButtonElement | null;
    expect(chip).not.toBeNull();
    fireEvent.click(chip!);
    expect(onCitationClick).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555');
  });
});
