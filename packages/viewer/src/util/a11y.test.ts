import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { type RefObject } from 'react';
import { onActivate, useFocusTrap } from './a11y.js';

/**
 * Helper to build a container with N focusable buttons and an optional
 * outside-the-trap "previous focus" element to verify restore-on-unmount
 * behavior. `getFocusable` in `a11y.ts` checks `el.offsetParent != null`
 * to skip invisible elements, but jsdom's layout is a no-op so every
 * `offsetParent` is null by default. Stub it on every focusable so the
 * trap's visibility filter doesn't trivially reject them.
 */
function buildScene(buttonCount: number): {
  container: HTMLDivElement;
  outside: HTMLButtonElement;
  buttons: HTMLButtonElement[];
} {
  const outside = document.createElement('button');
  outside.textContent = 'OUTSIDE';
  Object.defineProperty(outside, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
  document.body.appendChild(outside);
  const container = document.createElement('div');
  // tabIndex=-1 so the container itself is focusable as the "no-focusables"
  // fallback target (matches modal containers in the viewer).
  container.tabIndex = -1;
  document.body.appendChild(container);
  const buttons: HTMLButtonElement[] = [];
  for (let i = 0; i < buttonCount; i += 1) {
    const b = document.createElement('button');
    b.textContent = `B${i}`;
    Object.defineProperty(b, 'offsetParent', {
      configurable: true,
      get: () => container,
    });
    container.appendChild(b);
    buttons.push(b);
  }
  return { container, outside, buttons };
}

describe('onActivate', () => {
  it('fires the callback on Enter', () => {
    let count = 0;
    const fakeEvent = {
      key: 'Enter',
      preventDefault: () => {},
    } as React.KeyboardEvent;
    onActivate(fakeEvent, () => {
      count += 1;
    });
    expect(count).toBe(1);
  });

  it('fires the callback on Space', () => {
    let count = 0;
    const fakeEvent = {
      key: ' ',
      preventDefault: () => {},
    } as React.KeyboardEvent;
    onActivate(fakeEvent, () => {
      count += 1;
    });
    expect(count).toBe(1);
  });

  it('does not fire on other keys', () => {
    let count = 0;
    const fakeEvent = {
      key: 'a',
      preventDefault: () => {},
    } as React.KeyboardEvent;
    onActivate(fakeEvent, () => {
      count += 1;
    });
    expect(count).toBe(0);
  });
});

describe('useFocusTrap (review-loop iter-2 SR2)', () => {
  let cleanup: Array<() => void> = [];

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(() => {
    cleanup.forEach((fn) => fn());
    document.body.innerHTML = '';
  });

  it('focuses the first focusable in the container when active=true', async () => {
    const { container, outside, buttons } = buildScene(3);
    cleanup.push(() => container.remove());
    cleanup.push(() => outside.remove());

    const containerRef: RefObject<HTMLElement | null> = { current: container };
    const { unmount } = renderHook(() => useFocusTrap(true, containerRef));
    cleanup.push(unmount);

    // The trap uses setTimeout(..., 0) to defer focus; await one microtask + macrotask.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('focuses initialFocusRef when provided (overrides first-focusable)', async () => {
    const { container, buttons } = buildScene(3);
    cleanup.push(() => container.remove());

    const containerRef: RefObject<HTMLElement | null> = { current: container };
    const initialFocusRef: RefObject<HTMLElement | null> = { current: buttons[2]! };
    const { unmount } = renderHook(() => useFocusTrap(true, containerRef, initialFocusRef));
    cleanup.push(unmount);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(document.activeElement).toBe(buttons[2]);
  });

  it('falls back to focusing the container when no focusables are present', async () => {
    const { container } = buildScene(0);
    cleanup.push(() => container.remove());

    const containerRef: RefObject<HTMLElement | null> = { current: container };
    const { unmount } = renderHook(() => useFocusTrap(true, containerRef));
    cleanup.push(unmount);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(document.activeElement).toBe(container);
  });

  it('does nothing when active=false', async () => {
    const { container, outside } = buildScene(3);
    cleanup.push(() => container.remove());
    cleanup.push(() => outside.remove());
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const containerRef: RefObject<HTMLElement | null> = { current: container };
    const { unmount } = renderHook(() => useFocusTrap(false, containerRef));
    cleanup.push(unmount);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(document.activeElement).toBe(outside);
  });

  it('Tab on last focusable cycles to first (forward wrap)', async () => {
    const { container, buttons } = buildScene(3);
    cleanup.push(() => container.remove());

    const containerRef: RefObject<HTMLElement | null> = { current: container };
    const { unmount } = renderHook(() => useFocusTrap(true, containerRef));
    cleanup.push(unmount);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    buttons[2]!.focus();
    expect(document.activeElement).toBe(buttons[2]);

    act(() => {
      const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      container.dispatchEvent(evt);
    });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('Shift+Tab on first focusable cycles to last (backward wrap)', async () => {
    const { container, buttons } = buildScene(3);
    cleanup.push(() => container.remove());

    const containerRef: RefObject<HTMLElement | null> = { current: container };
    const { unmount } = renderHook(() => useFocusTrap(true, containerRef));
    cleanup.push(unmount);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    buttons[0]!.focus();
    expect(document.activeElement).toBe(buttons[0]);

    act(() => {
      const evt = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true });
      container.dispatchEvent(evt);
    });
    expect(document.activeElement).toBe(buttons[2]);
  });

  it('restores focus to the previously-active element on unmount', async () => {
    const { container, outside } = buildScene(3);
    cleanup.push(() => container.remove());
    cleanup.push(() => outside.remove());

    outside.focus();
    expect(document.activeElement).toBe(outside);

    const containerRef: RefObject<HTMLElement | null> = { current: container };
    const { unmount } = renderHook(() => useFocusTrap(true, containerRef));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    // Trap captured `outside` as previousActive; first button now has focus.
    expect(document.activeElement).not.toBe(outside);

    unmount();
    expect(document.activeElement).toBe(outside);
  });
});
