import { describe, expect, it } from 'vitest';

import {
  assertLocalhostBind,
  LOCALHOST_BIND_POLICY,
  LocalhostBindError,
} from './localhostBind.js';

describe('assertLocalhostBind', () => {
  describe('stdio', () => {
    it('accepts kind=stdio with no host/port', () => {
      const desc = assertLocalhostBind({ kind: 'stdio' });
      expect(desc).toEqual({ kind: 'stdio' });
    });

    it('returns the same frozen stdio descriptor regardless of stray host/port', () => {
      // We don't reject extra fields on stdio — the protocol
      // layer ignores them. But the returned shape stays canonical.
      const desc = assertLocalhostBind({ kind: 'stdio', host: 'ignored', port: 99 });
      expect(desc).toEqual({ kind: 'stdio' });
    });
  });

  describe('tcp — loopback acceptance', () => {
    it.each(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])(
      'accepts loopback host "%s" with valid port',
      (host) => {
        const desc = assertLocalhostBind({ kind: 'tcp', host, port: 4444 });
        expect(desc).toEqual({ kind: 'tcp', host, port: 4444 });
      },
    );
  });

  describe('tcp — non-loopback rejection', () => {
    it.each([
      '0.0.0.0',
      '192.168.1.5',
      '10.0.0.1',
      'public-host.example.com',
      'localhost.evil.com',
      'LOCALHOST', // case-sensitive
      '127.0.0.2', // wrong subnet
    ])('rejects non-loopback "%s"', (host) => {
      try {
        assertLocalhostBind({ kind: 'tcp', host, port: 4444 });
      } catch (e) {
        expect(e).toBeInstanceOf(LocalhostBindError);
        expect((e as LocalhostBindError).code).toBe('non-loopback');
        return;
      }
      throw new Error(`expected rejection of "${host}"`);
    });
  });

  describe('tcp — port validation', () => {
    it.each([
      [0, 'port=0 (asks OS to pick, ambiguous)'],
      [-1, 'negative port'],
      [65536, 'port over 16-bit range'],
      [3.14, 'non-integer port'],
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
    ])('rejects port %s — %s', (port) => {
      try {
        assertLocalhostBind({
          kind: 'tcp',
          host: '127.0.0.1',
          port: port as number,
        });
      } catch (e) {
        expect((e as LocalhostBindError).code).toBe('invalid-port');
        return;
      }
      throw new Error(`expected rejection of port=${port}`);
    });

    it('rejects when port is missing', () => {
      try {
        assertLocalhostBind({ kind: 'tcp', host: '127.0.0.1' });
      } catch (e) {
        expect((e as LocalhostBindError).code).toBe('invalid-port');
        return;
      }
      throw new Error('expected rejection of missing port');
    });
  });

  describe('tcp — host validation', () => {
    it('rejects empty host', () => {
      try {
        assertLocalhostBind({ kind: 'tcp', host: '', port: 4444 });
      } catch (e) {
        expect((e as LocalhostBindError).code).toBe('empty');
        return;
      }
      throw new Error('expected rejection of empty host');
    });

    it('rejects when host is missing', () => {
      try {
        assertLocalhostBind({ kind: 'tcp', port: 4444 });
      } catch (e) {
        expect((e as LocalhostBindError).code).toBe('empty');
        return;
      }
      throw new Error('expected rejection of missing host');
    });
  });

  describe('invalid kind', () => {
    it('rejects unknown kind', () => {
      try {
        assertLocalhostBind({
          kind: 'http' as 'stdio' | 'tcp',
          host: '127.0.0.1',
          port: 4444,
        });
      } catch (e) {
        expect((e as LocalhostBindError).code).toBe('invalid-kind');
        return;
      }
      throw new Error('expected rejection of kind=http');
    });
  });

  describe('LOCALHOST_BIND_POLICY export', () => {
    it('exposes loopback literals + allowed kinds for inspection', () => {
      expect(LOCALHOST_BIND_POLICY.loopbackLiterals).toContain('127.0.0.1');
      expect(LOCALHOST_BIND_POLICY.loopbackLiterals).toContain('::1');
      expect(LOCALHOST_BIND_POLICY.loopbackLiterals).toContain('localhost');
      expect(LOCALHOST_BIND_POLICY.allowedKinds).toEqual(['stdio', 'tcp']);
    });

    it('is frozen', () => {
      expect(Object.isFrozen(LOCALHOST_BIND_POLICY)).toBe(true);
      expect(Object.isFrozen(LOCALHOST_BIND_POLICY.loopbackLiterals)).toBe(true);
      expect(Object.isFrozen(LOCALHOST_BIND_POLICY.allowedKinds)).toBe(true);
    });
  });
});
