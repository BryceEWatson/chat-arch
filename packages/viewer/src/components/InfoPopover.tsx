import { useEffect, useRef, useState } from 'react';
import { onActivate } from '../util/a11y.js';

/**
 * Small clickable "ⓘ" button that opens an anchored popover with help
 * text. Kept separate from the surrounding action button so that
 * clicking the glyph does NOT fire the action — you can read the docs
 * without, say, triggering a rescan.
 *
 * Popover closes on: background click, Escape, or toggling the glyph.
 * Positioned below the trigger and clipped within the viewport.
 */

export interface InfoPopoverProps {
  /** Accessible label for the ⓘ button. */
  ariaLabel: string;
  /** Rich help content; rendered inside the popover. Plain text is fine. */
  children: React.ReactNode;
  /**
   * Extra class on the anchor wrapper. Lets the caller size / position
   * the ⓘ relative to a neighbouring control without re-styling the
   * popover internals.
   */
  className?: string;
}

export function InfoPopover({ ariaLabel, children, className }: InfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  // Close on outside click + Escape. Bound lazily so the `useEffect`
  // cost is zero when the popover isn't open.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation(); // don't bubble into the neighbouring button
    setOpen((v) => !v);
  };

  return (
    <span ref={rootRef} className={`lcars-info-popover${className ? ` ${className}` : ''}`}>
      <span
        className={`lcars-info-popover__trigger${open ? ' lcars-info-popover__trigger--open' : ''}`}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={toggle}
        onKeyDown={(e) => onActivate(e, () => toggle(e))}
      >
        {/* Plain lowercase `i` in Antonio — matches the source-pill
            badge convention (single letter in a circle) and avoids
            the ⓘ Unicode glyph which rendered inconsistently and
            read as off-theme. */}
        i
      </span>
      {open && (
        <span
          className="lcars-info-popover__panel"
          role="dialog"
          aria-label={ariaLabel}
          // Stop propagation so clicking inside the panel doesn't
          // close it via the outside-click handler above.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </span>
      )}
    </span>
  );
}
