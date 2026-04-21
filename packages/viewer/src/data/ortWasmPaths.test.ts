import { describe, it, expect } from 'vitest';
import { resolveOrtWasmPaths } from './ortWasmPaths.js';

describe('resolveOrtWasmPaths', () => {
  it('builds the same-origin asset URLs from a normal origin', () => {
    const r = resolveOrtWasmPaths('https://chat-arch.example');
    expect(r.base).toBe('https://chat-arch.example/ort-wasm/');
    expect(r.mjs).toBe('https://chat-arch.example/ort-wasm/ort-wasm-simd-threaded.jsep.mjs');
    expect(r.wasm).toBe('https://chat-arch.example/ort-wasm/ort-wasm-simd-threaded.jsep.wasm');
  });

  it('handles an http://localhost dev-server origin', () => {
    const r = resolveOrtWasmPaths('http://localhost:4324');
    expect(r.base).toBe('http://localhost:4324/ort-wasm/');
  });

  it('throws — does NOT silently fall back — when origin is undefined', () => {
    // Simulates a worker runtime where `self.location` is missing.
    // The previous try/catch would have let this slip through to
    // transformers.js's jsdelivr default. Fail-closed is the fix.
    expect(() => resolveOrtWasmPaths(undefined)).toThrow(/self\.location\.origin is unavailable/);
    expect(() => resolveOrtWasmPaths(undefined)).toThrow(/third-party WASM CDN/);
  });

  it('throws when origin is null', () => {
    expect(() => resolveOrtWasmPaths(null)).toThrow(/self\.location\.origin/);
  });

  it('throws when origin is an empty string', () => {
    // `new URL('x', '')` would also throw later — fail early instead.
    expect(() => resolveOrtWasmPaths('')).toThrow(/self\.location\.origin/);
  });

  it('throws on a non-string origin (defensive)', () => {
    // File-safe guard against a hostile or exotic worker runtime.
    expect(() => resolveOrtWasmPaths(42)).toThrow(/self\.location\.origin/);
    expect(() => resolveOrtWasmPaths({})).toThrow(/self\.location\.origin/);
  });

  it('error message never mentions a specific CDN URL — only the policy', () => {
    // Avoid giving operators the impression they can "just configure"
    // the CDN; the message is about the policy (no third-party fetch).
    try {
      resolveOrtWasmPaths(undefined);
      throw new Error('expected throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain('jsdelivr');
      expect(msg).not.toContain('cdn');
    }
  });
});
