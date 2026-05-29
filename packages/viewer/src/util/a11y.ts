import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

/**
 * Uniform keyboard activation handler for `<div role="button" tabIndex={0}>`.
 *
 * Why this pattern (called out in plan decision 4): native `<button>` user-agent
 * styles override LCARS background colors in some browsers and a bug in the
 * v7 LCARS iteration forced us off `<button>`. So every interactive panel is
 * a `<div>` with `role="button"` + this helper on `onKeyDown` so Enter / Space
 * still activate.
 */
export function onActivate<T extends Element>(e: ReactKeyboardEvent<T>, cb: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    cb();
  }
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), ' +
  '[role="button"]:not([aria-disabled="true"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute('inert')) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    const ti = el.getAttribute('tabindex');
    if (ti != null && Number(ti) < 0) return false;
    return el.offsetParent != null || el === container;
  });
}

/**
 * Focus trap + restore for modal dialogs.
 *
 * - On `active` true: captures `document.activeElement`, focuses the
 *   `initialFocusRef` if provided (else the first focusable in `containerRef`,
 *   else the container itself).
 * - While active: Tab cycles last→first, Shift+Tab cycles first→last.
 *   Tab handling is bound to the container, so consumers must ensure the
 *   container is in the DOM and reachable when `active` flips to true.
 * - On `active` false (or unmount): restores focus to the previously-active
 *   element if it's still in the DOM and focusable.
 *
 * Escape handling is NOT included — components keep their own onClose Esc
 * handlers because the close action is consumer-specific.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    const previousActive = (document.activeElement as HTMLElement | null) ?? null;
    const target = initialFocusRef?.current ?? getFocusable(container)[0] ?? container;
    const focusTimer = window.setTimeout(() => target?.focus?.(), 0);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const items = getFocusable(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(focusTimer);
      container.removeEventListener('keydown', onKey);
      if (previousActive && document.contains(previousActive)) {
        previousActive.focus?.();
      }
    };
  }, [active, containerRef, initialFocusRef]);
}
