import { useState } from 'react';

/**
 * Wave 7 P1 #6 — small reusable `[copy]` button used on cards across
 * INSIGHTS / TRUST / EFFECTIVENESS. Emits a markdown blockquote
 * containing:
 *
 *   - the card's primary readout (deltaCI / eValueCIBound / etc.)
 *   - sample sizes / n values
 *   - a pre-baked methodology footer line so the snippet is safe to
 *     paste into chat without losing the descriptive-contrast framing
 *
 * The methodology footer is identical across cards; this component
 * owns the single canonical wording so we can't drift between
 * surfaces.
 */

export const COPY_MARKDOWN_FOOTER =
  '*Descriptive contrast over Bryce\'s own corpus; not a causal estimate. ' +
  'Confounding by indication attenuated but not eliminated. ' +
  'Methodology: chat-arch viewer → Methodology & limitations.*';

export interface CopyMarkdownButtonProps {
  /** Single-line title for the blockquote header. */
  title: string;
  /**
   * Lines making up the body of the blockquote. Each line will be
   * prefixed with `> ` so the whole block renders as a blockquote in
   * markdown.
   */
  bodyLines: readonly string[];
  /** Optional aria-label / tooltip override. */
  label?: string;
  /** Optional testid for per-card test disambiguation. */
  testId?: string;
}

function buildMarkdown(title: string, bodyLines: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`> **${title}**`);
  lines.push('>');
  for (const l of bodyLines) {
    // Preserve internal blank lines but always prefix with the blockquote marker.
    if (l.length === 0) lines.push('>');
    else lines.push(`> ${l}`);
  }
  lines.push('>');
  lines.push(`> ${COPY_MARKDOWN_FOOTER}`);
  return lines.join('\n');
}

export function CopyMarkdownButton({
  title,
  bodyLines,
  label = 'copy as markdown',
  testId,
}: CopyMarkdownButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const onCopy = async () => {
    const text = buildMarkdown(title, bodyLines);
    if (
      typeof navigator === 'undefined' ||
      navigator.clipboard === undefined
    ) {
      setState('failed');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      // Reset after ~1.5s so the same button can be re-used.
      window.setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('failed');
    }
  };

  return (
    <button
      type="button"
      className="lcars-copy-md-btn"
      onClick={() => void onCopy()}
      aria-label={label}
      title={label}
      data-state={state}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {state === 'copied' ? '[copied]' : state === 'failed' ? '[copy x]' : '[copy]'}
    </button>
  );
}

// Re-export for tests that need to assert on the exact markdown output.
export const __test = { buildMarkdown };
