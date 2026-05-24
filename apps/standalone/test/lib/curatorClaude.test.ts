/**
 * Tests for the Phase Rev3-F F5 + F6 subprocess infrastructure.
 *
 * Coverage strategy: the pure helpers (`apiKeyFallbackAllowedFromEnv`)
 * and any path that runs without a real child_process spawn are
 * tested directly. The spawn paths (`probeClaudeAvailable` happy +
 * non-zero-exit) are covered implicitly when /curate consumes the
 * helper in F3+F4 against a real `claude` install — vitest's ESM
 * module-spying can't intercept `node:child_process.spawn` cleanly,
 * so a bogus-binary smoke test is the only spawn-touching case
 * exercised here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiKeyFallbackAllowedFromEnv,
  probeClaudeAvailable,
} from '../../src/lib/curatorClaude.js';
import * as resolveClaudeModule from '../../src/lib/resolveClaude.js';

beforeEach(() => {
  // ensure a clean slate every test
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'];
});

describe('apiKeyFallbackAllowedFromEnv (F6 default-deny gate)', () => {
  it('returns false when the env var is unset', () => {
    delete process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'];
    expect(apiKeyFallbackAllowedFromEnv()).toBe(false);
  });

  it('returns false on common falsy values', () => {
    for (const v of ['', '0', 'false', 'no', 'off']) {
      process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'] = v;
      expect(apiKeyFallbackAllowedFromEnv()).toBe(false);
    }
  });

  it('returns true ONLY on the explicit `1` opt-in', () => {
    process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'] = '1';
    expect(apiKeyFallbackAllowedFromEnv()).toBe(true);
  });

  it('treats `true` / `yes` / `on` as deny (strict equality with `1`)', () => {
    // Prevents a user typing `true` in a `.env` and thinking that's
    // enabled. The plan's "API-key fallback OFF by default" rule is
    // safer when the opt-in mechanism is strict.
    for (const v of ['true', 'yes', 'on', 'TRUE', '1.0', ' 1']) {
      process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'] = v;
      expect(apiKeyFallbackAllowedFromEnv()).toBe(false);
    }
  });
});

describe('probeClaudeAvailable — bogus-binary smoke test', () => {
  it('returns available=false + reason=spawn-error when binary path is bogus', async () => {
    vi.spyOn(resolveClaudeModule, 'resolveClaudeBin').mockReturnValue({
      file: '/no/such/binary-on-this-machine-xyz-rev3f',
      useShell: false,
      source: 'env',
    });
    const result = await probeClaudeAvailable();
    expect(result.available).toBe(false);
    expect(result.reason).toBe('spawn-error');
  });
});
