import { describe, expect, it } from 'vitest';
import {
  REQUIRED_HEADER,
  classifyOutcome,
  isLocalOrigin,
  type OutcomeProbe,
} from '../../src/pages/api/mine-corrections.js';

const emptyProbe: OutcomeProbe = {
  correctionsGeneratedAt: null,
  statusFileStatus: null,
  statusFileError: null,
};

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

describe('mine-corrections — classifyOutcome', () => {
  const started = 1_000_000;

  it('reports success when corrections.json is fresh and exit was clean', () => {
    const verdict = classifyOutcome(started, 0, null, {
      ...emptyProbe,
      correctionsGeneratedAt: started + 5_000,
      statusFileStatus: 'complete',
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('reports success when corrections.json generatedAt equals startedAt', () => {
    // Boundary: skill could write generatedAt = exact start ms. Don't
    // false-negative on that edge.
    const verdict = classifyOutcome(started, 0, null, {
      ...emptyProbe,
      correctionsGeneratedAt: started,
    });
    expect(verdict.ok).toBe(true);
  });

  it('flags the silent-abort path: exit 0 but no corrections.json written', () => {
    // This is the bug that motivated the helper: claude -p exits clean
    // because the skill printed a question and gave up, but nothing
    // landed on disk. The verdict must surface that, not pass it
    // through as success.
    const verdict = classifyOutcome(started, 0, null, emptyProbe);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/didn't produce a fresh corrections file/);
    expect(verdict.reason).toMatch(/aborted before writing any progress/);
  });

  it('flags the silent-abort path even when corrections.json is stale', () => {
    // Prior run's output still on disk from earlier mining. New run
    // didn't refresh it. Must not credit the prior run.
    const verdict = classifyOutcome(started, 0, null, {
      ...emptyProbe,
      correctionsGeneratedAt: started - 60_000,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/didn't produce a fresh corrections file/);
  });

  it('surfaces the skill error message when status file says error', () => {
    const verdict = classifyOutcome(started, 0, null, {
      correctionsGeneratedAt: null,
      statusFileStatus: 'error',
      statusFileError: 'Ollama is not running',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(
      'the mining skill reported an error: Ollama is not running',
    );
  });

  it('falls back to a placeholder when status=error has no message', () => {
    const verdict = classifyOutcome(started, 0, null, {
      correctionsGeneratedAt: null,
      statusFileStatus: 'error',
      statusFileError: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/mining skill reported an error/);
  });

  it('includes the last-known phase when corrections is missing but status was non-error', () => {
    // Skill crashed mid-pipeline without writing status=error.
    const verdict = classifyOutcome(started, 0, null, {
      correctionsGeneratedAt: null,
      statusFileStatus: 'classifying',
      statusFileError: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/last progress update was: classifying/);
  });

  it('reports spawn errors before checking output', () => {
    const verdict = classifyOutcome(
      started,
      null,
      new Error('ENOENT: claude not on PATH'),
      emptyProbe,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/couldn't launch the claude CLI/);
    expect(verdict.reason).toMatch(/PATH/);
  });

  it('reports a non-zero exit code over the on-disk probe', () => {
    const verdict = classifyOutcome(started, 1, null, {
      ...emptyProbe,
      correctionsGeneratedAt: started + 1_000,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/^the claude CLI exited with code 1\b/);
  });

  it('annotates Windows DLL-init exit codes with a remediation hint', () => {
    const verdict = classifyOutcome(started, 0xc0000142, null, emptyProbe);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/Windows DLL initialization/);
  });
});
