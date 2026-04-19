import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { tierForWidth, useViewportTier } from './viewport.js';

describe('tierForWidth', () => {
  it('returns mobile below 600px', () => {
    expect(tierForWidth(0)).toBe('mobile');
    expect(tierForWidth(320)).toBe('mobile');
    expect(tierForWidth(599)).toBe('mobile');
  });

  it('returns tablet between 600 and 899px inclusive/exclusive', () => {
    expect(tierForWidth(600)).toBe('tablet');
    expect(tierForWidth(768)).toBe('tablet');
    expect(tierForWidth(899)).toBe('tablet');
  });

  it('returns desktop at or above 900px', () => {
    expect(tierForWidth(900)).toBe('desktop');
    expect(tierForWidth(1200)).toBe('desktop');
    expect(tierForWidth(1920)).toBe('desktop');
  });
});

describe('useViewportTier', () => {
  let originalWidth: number;

  beforeEach(() => {
    originalWidth = window.innerWidth;
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalWidth,
    });
    vi.restoreAllMocks();
  });

  function setWidth(w: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  }

  it('returns the current tier at mount', () => {
    setWidth(1400);
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toBe('desktop');
  });

  it('reports tablet at 768', () => {
    setWidth(768);
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toBe('tablet');
  });

  it('reports mobile at 375', () => {
    setWidth(375);
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toBe('mobile');
  });

  it('updates when the window resizes across breakpoints', () => {
    setWidth(1400);
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toBe('desktop');

    act(() => {
      setWidth(700);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe('tablet');

    act(() => {
      setWidth(375);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe('mobile');

    act(() => {
      setWidth(1200);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe('desktop');
  });
});
