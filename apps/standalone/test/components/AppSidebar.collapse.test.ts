import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STORAGE_KEY,
  MOBILE_MEDIA,
  readStoredCollapsed,
  writeStoredCollapsed,
  initialCollapsedFor,
} from '../../src/scripts/appSidebarCollapse.ts';

// Pure helpers test — exercises the collapse state machine without
// JSDOM. The Astro component's inline <script> calls these against the
// real `window.localStorage` / `matchMedia` at runtime; tests stub a
// minimal Storage / matchMedia and assert the contract.

function makeStorage(initial: Record<string, string> = {}): Storage {
  const store: Record<string, string> = { ...initial };
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem: (k: string) => (k in store ? store[k] : null),
    key: (i: number) => Object.keys(store)[i] ?? null,
    removeItem: (k: string) => {
      delete store[k];
    },
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };
}

describe('appSidebarCollapse — storage helpers', () => {
  it('exposes the canonical storage key + media query', () => {
    expect(STORAGE_KEY).toBe('chat-arch:sidebar-collapsed');
    expect(MOBILE_MEDIA).toBe('(max-width: 899px)');
  });

  it('readStoredCollapsed returns false when key is absent', () => {
    expect(readStoredCollapsed(makeStorage())).toBe(false);
  });

  it('readStoredCollapsed returns true when value is "true"', () => {
    expect(readStoredCollapsed(makeStorage({ [STORAGE_KEY]: 'true' }))).toBe(true);
  });

  it('readStoredCollapsed returns false for any other string', () => {
    expect(readStoredCollapsed(makeStorage({ [STORAGE_KEY]: 'false' }))).toBe(false);
    expect(readStoredCollapsed(makeStorage({ [STORAGE_KEY]: 'yes' }))).toBe(false);
  });

  it('writeStoredCollapsed persists the boolean as "true" / "false"', () => {
    const s = makeStorage();
    writeStoredCollapsed(s, true);
    expect(s.getItem(STORAGE_KEY)).toBe('true');
    writeStoredCollapsed(s, false);
    expect(s.getItem(STORAGE_KEY)).toBe('false');
  });

  it('readStoredCollapsed tolerates a throwing storage (policy-locked) and returns false', () => {
    const blocker: Storage = {
      length: 0,
      clear: () => {
        throw new Error('blocked');
      },
      getItem: () => {
        throw new Error('blocked');
      },
      key: () => null,
      removeItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredCollapsed(blocker)).toBe(false);
  });

  it('writeStoredCollapsed swallows errors from a policy-locked storage', () => {
    const blocker: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => writeStoredCollapsed(blocker, true)).not.toThrow();
  });
});

describe('appSidebarCollapse — initialCollapsedFor', () => {
  it('returns true when matchMedia matches (mobile), regardless of storage', () => {
    expect(initialCollapsedFor({ stored: false, mobile: true })).toBe(true);
    expect(initialCollapsedFor({ stored: true, mobile: true })).toBe(true);
  });

  it('returns the stored value when matchMedia does not match (desktop)', () => {
    expect(initialCollapsedFor({ stored: false, mobile: false })).toBe(false);
    expect(initialCollapsedFor({ stored: true, mobile: false })).toBe(true);
  });
});
