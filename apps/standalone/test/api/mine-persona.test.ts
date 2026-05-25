import { describe, expect, it } from 'vitest';
import {
  REQUIRED_HEADER,
  classifyOutcome,
  isLocalOrigin,
  type PersonaOutcomeProbe,
} from '../../src/pages/api/mine-persona.js';

const emptyProbe: PersonaOutcomeProbe = {
  personasGeneratedAt: null,
  statusFileStatus: null,
  statusFileError: null,
};

// Mirror of mine-corrections.test.ts — the persona endpoint shares the
// shape line-for-line, and divergence between the two on the CSRF /
// silent-abort logic would defeat the parity these tests pin. Add a
// matching case here whenever mine-corrections grows one.

describe('mine-persona — CSRF gate', () => {
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
    // Pinned so a rename can't silently 403 the SCAN chain's 5th step.
    expect(REQUIRED_HEADER).toBe('chat-arch-mine-persona');
  });
});

describe('mine-persona — classifyOutcome', () => {
  const started = 1_000_000;

  it('reports success when personas.json is fresh and exit was clean', () => {
    const verdict = classifyOutcome(started, 0, null, {
      ...emptyProbe,
      personasGeneratedAt: started + 5_000,
      statusFileStatus: 'complete',
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('reports success when personas.json generatedAt equals startedAt', () => {
    // Boundary: skill could write generatedAt = exact start ms.
    const verdict = classifyOutcome(started, 0, null, {
      ...emptyProbe,
      personasGeneratedAt: started,
      statusFileStatus: 'complete',
    });
    expect(verdict.ok).toBe(true);
  });

  it('reports failure when claude CLI exits non-zero', () => {
    const verdict = classifyOutcome(started, 1, null, {
      ...emptyProbe,
      personasGeneratedAt: started + 5_000,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/exited with code 1/);
  });

  it('reports failure when spawn errored', () => {
    const verdict = classifyOutcome(
      started,
      null,
      new Error('ENOENT claude'),
      emptyProbe,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/spawn error: ENOENT claude/);
  });

  it('takes status-file `error` precedence over a stale personas.json', () => {
    // The status file is the skill's own self-report; if it says error,
    // that's authoritative even when personas.json happens to be fresh
    // (e.g. a prior successful run sits on disk).
    const verdict = classifyOutcome(started, 0, null, {
      personasGeneratedAt: started + 1,
      statusFileStatus: 'error',
      statusFileError: 'persona-candidates.json missing',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/skill reported error: persona-candidates\.json missing/);
  });

  it('reports the silent-abort failure mode: CLI exits 0 but personas.json is stale', () => {
    // The "skill exited cleanly but didn't write" path — the failure
    // mode the corrections endpoint added classifyOutcome to catch.
    // Persona endpoint inherits the shape; this test pins it.
    const verdict = classifyOutcome(started, 0, null, {
      ...emptyProbe,
      personasGeneratedAt: started - 5_000, // prior run, not refreshed
      statusFileStatus: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/did not write a fresh personas\.json/);
  });

  it('reports the silent-abort failure mode when personas.json is missing entirely', () => {
    const verdict = classifyOutcome(started, 0, null, emptyProbe);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/did not write a fresh personas\.json/);
  });
});
