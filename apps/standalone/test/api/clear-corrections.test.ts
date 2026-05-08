import { describe, expect, it } from 'vitest';
import {
  REQUIRED_HEADER,
  isLocalOrigin,
  isMiningArtifact,
} from '../../src/pages/api/clear-corrections.js';

describe('clear-corrections — CSRF gate', () => {
  it('accepts loopback origins, rejects everything else', () => {
    expect(isLocalOrigin('http://localhost:4324')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1')).toBe(true);
    expect(isLocalOrigin('http://[::1]')).toBe(true);
    expect(isLocalOrigin(null)).toBe(false);
    expect(isLocalOrigin('http://example.com')).toBe(false);
    expect(isLocalOrigin('file:///')).toBe(false);
  });

  it('exposes a distinct X-Requested-With header from /api/mine-corrections', () => {
    // If the two endpoints' header tokens collide, a CSRF that targets
    // one would also fire the other. Pin them as distinct.
    expect(REQUIRED_HEADER).toBe('chat-arch-clear-corrections');
  });
});

describe('clear-corrections — isMiningArtifact allow-list', () => {
  it('matches the three documented patterns', () => {
    expect(isMiningArtifact('corrections.json')).toBe(true);
    expect(isMiningArtifact('correction-status-abc-123.json')).toBe(true);
    expect(isMiningArtifact('correction-status-1614337e-5e34-4bb9-b89d-0b1de98cc131.json')).toBe(true);
    expect(isMiningArtifact('_correction-target-ids-abc-123.json')).toBe(true);
  });

  it('rejects sibling analysis files we do NOT own', () => {
    // These belong to other writers (exporter / topics / etc.) and
    // must never be deleted by /api/clear-corrections, regardless of
    // a user clicking the danger-zone button.
    expect(isMiningArtifact('correction-candidates.json')).toBe(false);
    expect(isMiningArtifact('manifest.json')).toBe(false);
    expect(isMiningArtifact('duplicates.exact.json')).toBe(false);
    expect(isMiningArtifact('zombies.heuristic.json')).toBe(false);
    expect(isMiningArtifact('projects.json')).toBe(false);
    expect(isMiningArtifact('topics.json')).toBe(false);
    expect(isMiningArtifact('narratives.json')).toBe(false);
    expect(isMiningArtifact('meta.json')).toBe(false);
    expect(isMiningArtifact('patterns.json')).toBe(false);
  });

  it('rejects look-alike names that try to slip past the prefix check', () => {
    expect(isMiningArtifact('corrections.json.bak')).toBe(false);
    expect(isMiningArtifact('corrections.txt')).toBe(false);
    expect(isMiningArtifact('Corrections.json')).toBe(false); // case-sensitive
    expect(isMiningArtifact('xcorrection-status-foo.json')).toBe(false);
    expect(isMiningArtifact('correction-status-foo.txt')).toBe(false);
    expect(isMiningArtifact('correction-status-')).toBe(false);
    expect(isMiningArtifact('')).toBe(false);
  });

  it('rejects directory traversal in the name', () => {
    // readdir() doesn't return entries with `..` in the name, but
    // pin the predicate's behavior anyway as defense-in-depth in
    // case the caller is ever changed to accept user input directly.
    expect(isMiningArtifact('../etc/passwd')).toBe(false);
    expect(isMiningArtifact('correction-status-../foo.json')).toBe(false);
    expect(isMiningArtifact('_correction-target-ids-../bar.json')).toBe(false);
  });
});
