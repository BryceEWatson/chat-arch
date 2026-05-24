/**
 * Tests for the Phase Rev3-F F6 viewer-side opt-in toggle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearCuratorApiKeyOptIn,
  isCuratorApiKeyOptInEnabled,
  loadCuratorApiKeyOptIn,
  setCuratorApiKeyOptIn,
} from './curatorApiKeyOptIn.js';

const KEY = 'chat-arch:curator-api-key-opt-in-v1';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('loadCuratorApiKeyOptIn / isCuratorApiKeyOptInEnabled', () => {
  it('returns the default off-state when no entry is stored', () => {
    expect(loadCuratorApiKeyOptIn()).toEqual({ optedIn: false, toggledAt: 0 });
    expect(isCuratorApiKeyOptInEnabled()).toBe(false);
  });

  it('returns the default off-state on malformed JSON', () => {
    localStorage.setItem(KEY, 'not json at all');
    expect(isCuratorApiKeyOptInEnabled()).toBe(false);
  });

  it('returns the default off-state when JSON parses but `optedIn` is missing/wrong type', () => {
    localStorage.setItem(KEY, JSON.stringify({ optedIn: 'yes' }));
    expect(isCuratorApiKeyOptInEnabled()).toBe(false);
  });

  it('returns the stored opt-in state when present and well-formed', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ optedIn: true, toggledAt: 42 }),
    );
    expect(loadCuratorApiKeyOptIn()).toEqual({ optedIn: true, toggledAt: 42 });
    expect(isCuratorApiKeyOptInEnabled()).toBe(true);
  });

  it('defaults toggledAt to 0 when malformed', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ optedIn: true, toggledAt: 'not-a-number' }),
    );
    expect(loadCuratorApiKeyOptIn()).toEqual({ optedIn: true, toggledAt: 0 });
  });
});

describe('setCuratorApiKeyOptIn', () => {
  it('writes the new state to localStorage', () => {
    setCuratorApiKeyOptIn(true, 1000);
    expect(loadCuratorApiKeyOptIn()).toEqual({ optedIn: true, toggledAt: 1000 });
  });

  it('overrides a previous value', () => {
    setCuratorApiKeyOptIn(true, 1000);
    setCuratorApiKeyOptIn(false, 2000);
    expect(loadCuratorApiKeyOptIn()).toEqual({
      optedIn: false,
      toggledAt: 2000,
    });
  });

  it('returns the would-be state', () => {
    const result = setCuratorApiKeyOptIn(true, 1234);
    expect(result).toEqual({ optedIn: true, toggledAt: 1234 });
  });
});

describe('clearCuratorApiKeyOptIn', () => {
  it('removes the stored entry and reverts to default', () => {
    setCuratorApiKeyOptIn(true);
    expect(isCuratorApiKeyOptInEnabled()).toBe(true);
    clearCuratorApiKeyOptIn();
    expect(isCuratorApiKeyOptInEnabled()).toBe(false);
  });

  it('is a no-op when no entry exists', () => {
    expect(() => clearCuratorApiKeyOptIn()).not.toThrow();
  });
});

describe('default-deny posture', () => {
  it('treats any non-strict-boolean stored value as off', () => {
    // Verify the F6 default-deny rule holds: a `string("true")` is
    // NOT enough; only the canonical boolean wins.
    for (const val of ['true', '1', 1, 'yes', 0]) {
      localStorage.setItem(KEY, JSON.stringify({ optedIn: val }));
      expect(isCuratorApiKeyOptInEnabled()).toBe(false);
    }
  });
});
