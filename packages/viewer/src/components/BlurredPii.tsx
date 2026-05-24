// Phase Rev3-B sub-task B9 — default-blur narrative preview text.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase Rev3-B:
//   "PII handling for narrative previews — default-blur with reveal-on-
//    click before any curator surface ships."
//
// Wraps prose-bearing narrative fields (title, body, evidence excerpts)
// in a CSS blur with an on-click reveal toggle. The blur is purely
// visual — the underlying text remains in the DOM so screen-readers
// can still navigate it (with an aria announcement that the field is
// PII-blurred until revealed).
//
// Rev3-F curator surfaces will surface narrative previews on a
// dedicated tier-1 / tier-2 feed; without this default-blur, a user
// glancing at the screen with the viewer open could broadcast every
// previewed narrative's title + body to anyone in line-of-sight. The
// reveal gesture is a deliberate opt-in per-card.
//
// Reveal state is per-component-instance (NOT persisted) by design:
// closing and re-opening a card re-blurs. Persisting would defeat the
// "default safe" framing; a future "always reveal" toggle could land
// in a workspace-scope preference if the friction is too high.

import { useState, type ReactNode } from 'react';

export interface BlurredPiiProps {
  /** The wrapped text content. Stays in the DOM unconditionally so
   *  screen-readers / search-on-page work; only its visual presentation
   *  changes with `revealed`. */
  readonly children: ReactNode;
  /** Extra className applied to the wrapper. Useful when the caller
   *  needs layout adjustments (`block` vs `inline`, etc.). */
  readonly className?: string;
  /** Human-readable label for the field (e.g. `"narrative title"`).
   *  Used in the reveal-button's accessible name so a screen-reader
   *  user knows what they're about to unhide. Defaults to
   *  `"PII content"`. */
  readonly label?: string;
  /** Override the initial reveal state — primarily for tests. In
   *  production the default-false ("blurred") behavior is the contract. */
  readonly initialRevealed?: boolean;
}

const REVEAL_LABEL_DEFAULT = 'PII content';

export function BlurredPii({
  children,
  className,
  label = REVEAL_LABEL_DEFAULT,
  initialRevealed = false,
}: BlurredPiiProps): JSX.Element {
  const [revealed, setRevealed] = useState<boolean>(initialRevealed);
  const wrapperClass = [
    'blurred-pii',
    revealed ? 'blurred-pii--revealed' : 'blurred-pii--blurred',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={wrapperClass}>
      <span
        className="blurred-pii__content"
        aria-hidden={revealed ? undefined : true}
      >
        {children}
      </span>
      {!revealed && (
        <button
          type="button"
          className="blurred-pii__reveal"
          onClick={() => setRevealed(true)}
          aria-label={`Reveal ${label} (PII-blurred by default)`}
        >
          Reveal {label}
        </button>
      )}
      {revealed && (
        <button
          type="button"
          className="blurred-pii__hide"
          onClick={() => setRevealed(false)}
          aria-label={`Re-blur ${label}`}
        >
          Hide
        </button>
      )}
      {/* Screen-reader-only announcement of the blur state, regardless
          of visual reveal. Lets keyboard-only users discover the
          reveal button without first finding the blurred prose. */}
      <span className="sr-only" aria-live="polite">
        {revealed ? `${label} revealed` : `${label} is PII-blurred — use the Reveal button to show`}
      </span>
    </span>
  );
}
