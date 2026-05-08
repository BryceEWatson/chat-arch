import { describe, expect, it } from 'vitest';
import {
  REQUIRED_HEADER,
  isLocalOrigin,
} from '../../src/pages/api/mine-corrections.js';

describe('mine-corrections — CSRF gate', () => {
  it('accepts http://localhost:<any>', () => {
    expect(isLocalOrigin('http://localhost:4324')).toBe(true);
    expect(isLocalOrigin('http://localhost')).toBe(true);
    expect(isLocalOrigin('https://localhost:8443')).toBe(true);
  });

  it('accepts the loopback IPv4 / IPv6 literals', () => {
    expect(isLocalOrigin('http://127.0.0.1')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1:4324')).toBe(true);
    expect(isLocalOrigin('http://[::1]:4324')).toBe(true);
  });

  it('rejects null / empty / whitespace', () => {
    expect(isLocalOrigin(null)).toBe(false);
    expect(isLocalOrigin('')).toBe(false);
    expect(isLocalOrigin('   ')).toBe(false);
  });

  it('rejects non-loopback hostnames', () => {
    expect(isLocalOrigin('http://example.com')).toBe(false);
    expect(isLocalOrigin('http://attacker.localhost.evil.com')).toBe(false);
    expect(isLocalOrigin('http://192.168.1.1')).toBe(false);
    // Sneaky: `localhost.evil.com` contains 'localhost' as a substring
    // but isn't actually localhost. The hostname-equality check guards this.
    expect(isLocalOrigin('http://localhost.evil.com')).toBe(false);
  });

  it('rejects non-http(s) protocols', () => {
    expect(isLocalOrigin('file:///etc/passwd')).toBe(false);
    expect(isLocalOrigin('data:text/html,foo')).toBe(false);
    expect(isLocalOrigin('javascript:alert(1)')).toBe(false);
    expect(isLocalOrigin('ftp://localhost')).toBe(false);
  });

  it('rejects malformed URLs without throwing', () => {
    expect(isLocalOrigin('not-a-url')).toBe(false);
    expect(isLocalOrigin('://broken')).toBe(false);
    expect(isLocalOrigin('http://')).toBe(false);
  });

  it('exposes the X-Requested-With header value', () => {
    // Pinned so a refactor can't silently rename it and break the
    // viewer client that posts the same string.
    expect(REQUIRED_HEADER).toBe('chat-arch-mine-corrections');
  });
});
