import { describe, expect, it } from 'vitest';
import {
  REQUIRED_HEADER,
  isLocalOrigin,
  isPersonaArtifact,
  isPersonaMarkdown,
} from '../../src/pages/api/clear-personas.js';

describe('clear-personas — CSRF gate', () => {
  it('accepts loopback origins, rejects everything else', () => {
    expect(isLocalOrigin('http://localhost:4324')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1')).toBe(true);
    expect(isLocalOrigin('http://[::1]')).toBe(true);
    expect(isLocalOrigin(null)).toBe(false);
    expect(isLocalOrigin('http://example.com')).toBe(false);
    expect(isLocalOrigin('file:///')).toBe(false);
  });

  it('exposes a distinct X-Requested-With header from sibling endpoints', () => {
    // If this token collides with /api/mine-persona, /api/clear-corrections,
    // /api/clear, etc., a CSRF that targets one would also fire the
    // others. Pin them as distinct.
    expect(REQUIRED_HEADER).toBe('chat-arch-clear-personas');
  });
});

describe('clear-personas — isPersonaArtifact allow-list (top-level analysis/)', () => {
  it('matches the documented top-level patterns', () => {
    expect(isPersonaArtifact('personas.json')).toBe(true);
    expect(isPersonaArtifact('persona-status-abc-123.json')).toBe(true);
    expect(
      isPersonaArtifact('persona-status-1614337e-5e34-4bb9-b89d-0b1de98cc131.json'),
    ).toBe(true);
  });

  it('rejects sibling analysis files we do NOT own', () => {
    // The Stage-1 candidates file is INPUT, not output — never deleted.
    expect(isPersonaArtifact('persona-candidates.json')).toBe(false);
    expect(isPersonaArtifact('manifest.json')).toBe(false);
    expect(isPersonaArtifact('corrections.json')).toBe(false);
    expect(isPersonaArtifact('correction-status-foo.json')).toBe(false);
    expect(isPersonaArtifact('curator-feed.json')).toBe(false);
    expect(isPersonaArtifact('falsifier-verdicts.json')).toBe(false);
    expect(isPersonaArtifact('meta.json')).toBe(false);
  });

  it('rejects look-alike names', () => {
    expect(isPersonaArtifact('personas.json.bak')).toBe(false);
    expect(isPersonaArtifact('personas.txt')).toBe(false);
    expect(isPersonaArtifact('Personas.json')).toBe(false); // case-sensitive
    expect(isPersonaArtifact('xpersona-status-foo.json')).toBe(false);
    expect(isPersonaArtifact('persona-status-')).toBe(false);
    expect(isPersonaArtifact('')).toBe(false);
  });

  it('rejects directory traversal in the name', () => {
    expect(isPersonaArtifact('../etc/passwd')).toBe(false);
    expect(isPersonaArtifact('persona-status-../foo.json')).toBe(false);
    expect(isPersonaArtifact('../personas.json')).toBe(false);
  });
});

describe('clear-personas — isPersonaMarkdown allow-list (analysis/personas/)', () => {
  it('matches any .md file inside the personas subdir', () => {
    expect(isPersonaMarkdown('chat-arch.md')).toBe(true);
    expect(isPersonaMarkdown('shopforge-v4.md')).toBe(true);
    expect(isPersonaMarkdown('a.md')).toBe(true);
    // UNASSIGNED project id (per `@chat-arch/schema`).
    expect(isPersonaMarkdown('__unassigned__.md')).toBe(true);
  });

  it('rejects non-markdown extensions', () => {
    expect(isPersonaMarkdown('chat-arch.json')).toBe(false);
    expect(isPersonaMarkdown('chat-arch.txt')).toBe(false);
    expect(isPersonaMarkdown('chat-arch')).toBe(false);
    expect(isPersonaMarkdown('chat-arch.md.bak')).toBe(false);
    expect(isPersonaMarkdown('')).toBe(false);
  });

  it('rejects directory traversal in the name', () => {
    expect(isPersonaMarkdown('../etc/passwd.md')).toBe(false);
    expect(isPersonaMarkdown('../../foo.md')).toBe(false);
    expect(isPersonaMarkdown('subdir/foo.md')).toBe(false);
    expect(isPersonaMarkdown('subdir\\foo.md')).toBe(false);
  });
});
