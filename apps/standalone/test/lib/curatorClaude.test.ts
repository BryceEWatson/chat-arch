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
  AUTH_ENV_VARS,
  computeAllowApiKeyFallback,
  probeClaudeAvailable,
  redactStderr,
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

describe('AUTH_ENV_VARS (iter-1 security finding — full scrub family)', () => {
  it('includes every variable the Anthropic SDK / claude CLI / Bedrock / Vertex auto-detect', () => {
    // Security iter-1 finding: scrubbing only ANTHROPIC_API_KEY was
    // insufficient — the CLI also honors AUTH_TOKEN / BEARER_TOKEN /
    // CLAUDE_API_KEY / API_TOKEN. Pin the canonical list here so a
    // future scrub-list change must update this test.
    expect(AUTH_ENV_VARS).toEqual(
      expect.arrayContaining([
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BEARER_TOKEN',
        'ANTHROPIC_API_TOKEN',
        'CLAUDE_API_KEY',
      ]),
    );
    // No accidental extras (catches typos like `ANTHRPIC_API_KEY`).
    expect(AUTH_ENV_VARS.length).toBe(5);
  });

  it('never contains a name with whitespace or wrong-case (process.env keys are case-sensitive)', () => {
    for (const name of AUTH_ENV_VARS) {
      expect(name).toBe(name.trim());
      expect(name).toBe(name.toUpperCase());
    }
  });
});

describe('redactStderr (iter-1 security finding — leak-prevention)', () => {
  it('returns the input unchanged when nothing matches a redaction pattern', () => {
    expect(redactStderr('plain error message')).toBe('plain error message');
    expect(redactStderr('')).toBe('');
  });

  it('redacts sk-ant-… key fragments anywhere in the string', () => {
    const dirty =
      'error: auth failed with key sk-ant-api03-abcdefHIJKLMNOPxyz at line 42';
    const cleaned = redactStderr(dirty);
    expect(cleaned).not.toContain('sk-ant-api03-');
    expect(cleaned).toContain('sk-ant-***REDACTED***');
  });

  it('redacts all occurrences when multiple keys appear', () => {
    const dirty =
      'header1: sk-ant-aaa header2: sk-ant-bbb trailing sk-ant-ccc';
    const cleaned = redactStderr(dirty);
    // No surviving alphanumeric run after the prefix in any match.
    expect(cleaned).not.toMatch(/sk-ant-[a-z0-9]/i);
    // All three matches replaced.
    const redactedCount = (cleaned.match(/REDACTED/g) ?? []).length;
    expect(redactedCount).toBe(3);
  });

  it('redacts user-home absolute paths when HOME / USERPROFILE is set', () => {
    const origHome = process.env['HOME'];
    const origUser = process.env['USERPROFILE'];
    try {
      // Use a synthetic home so the test doesn't depend on the
      // real machine's home value (it's already set, but tests
      // shouldn't rely on its content).
      process.env['HOME'] = '/syn/home/alice';
      delete process.env['USERPROFILE'];
      const dirty =
        'config not found at /syn/home/alice/.config/anthropic/settings.json';
      const cleaned = redactStderr(dirty);
      expect(cleaned).not.toContain('/syn/home/alice');
      expect(cleaned).toContain('~/.config/anthropic/settings.json');
    } finally {
      if (origHome !== undefined) process.env['HOME'] = origHome;
      else delete process.env['HOME'];
      if (origUser !== undefined) process.env['USERPROFILE'] = origUser;
    }
  });

  it('handles regex-metachar-bearing home paths safely', () => {
    const origHome = process.env['HOME'];
    try {
      // Home with `.` `(` `)` — all regex metachars. The implementation
      // must escape these or the regex throws / matches too aggressively.
      process.env['HOME'] = '/home/bob.user(test)';
      const dirty = 'file at /home/bob.user(test)/x.txt and elsewhere';
      const cleaned = redactStderr(dirty);
      expect(cleaned).toContain('~/x.txt');
      expect(cleaned).toContain('and elsewhere');
    } finally {
      if (origHome !== undefined) process.env['HOME'] = origHome;
      else delete process.env['HOME'];
    }
  });
});

describe('computeAllowApiKeyFallback (F6 two-rail AND, added in exit-review cleanup PR)', () => {
  // Both rails OFF → false.
  it('returns false when neither rail is set', () => {
    delete process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'];
    expect(computeAllowApiKeyFallback(false)).toBe(false);
    expect(computeAllowApiKeyFallback(true)).toBe(false); // server rail OFF
  });

  // Server rail ON + viewer rail OFF → false.
  it('returns false when only server rail is ON', () => {
    process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'] = '1';
    expect(computeAllowApiKeyFallback(false)).toBe(false);
    expect(computeAllowApiKeyFallback(undefined)).toBe(false);
    expect(computeAllowApiKeyFallback(null)).toBe(false);
  });

  // Both rails ON → true (the only ON path).
  it('returns true only when BOTH rails are explicitly ON', () => {
    process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'] = '1';
    expect(computeAllowApiKeyFallback(true)).toBe(true);
  });

  // Defensive: viewerOptIn must be the literal `true`, not stringly-
  // truthy. Per the helper's docstring — malformed request body
  // must fail closed.
  it('rejects stringly-truthy viewerOptIn ("true", "1", 1, "yes")', () => {
    process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'] = '1';
    expect(computeAllowApiKeyFallback('true')).toBe(false);
    expect(computeAllowApiKeyFallback('1')).toBe(false);
    expect(computeAllowApiKeyFallback(1)).toBe(false);
    expect(computeAllowApiKeyFallback('yes')).toBe(false);
    expect(computeAllowApiKeyFallback({})).toBe(false);
    expect(computeAllowApiKeyFallback([true])).toBe(false);
  });

  // The two-rail AND is order-independent.
  it('flipping either rail off independently kills the allow signal', () => {
    process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'] = '1';
    expect(computeAllowApiKeyFallback(true)).toBe(true);
    delete process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'];
    expect(computeAllowApiKeyFallback(true)).toBe(false); // env off
    process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'] = '1';
    expect(computeAllowApiKeyFallback(false)).toBe(false); // viewer off
  });
});
