import { describe, it, expect } from 'vitest';
import { maskedUploadLabel, formatBytes } from './uploadLabel.js';

/** jsdom File constructor doesn't round-trip arbitrary byte content
 *  reliably, but we only care about `name` + `size` here, so we wrap a
 *  bare File and re-pin the size. */
function fakeFile(name: string, size: number): File {
  const f = new File([], name);
  Object.defineProperty(f, 'size', { value: size, configurable: true });
  return f;
}

describe('maskedUploadLabel', () => {
  it('redacts a real claude.ai Privacy Export filename with embedded email', () => {
    // This is the actual shape claude.ai produces:
    //   data-YYYY-MM-DD-<user@domain.tld>.zip
    // The whole point of masking is to keep the email out of the
    // persisted sourceLabel and the activity log.
    const label = maskedUploadLabel(fakeFile('data-2026-04-20-user@example.com.zip', 27_600_000));
    expect(label).toBe('upload.zip (26.3 MB)');
    expect(label).not.toContain('user@example.com');
    expect(label).not.toContain('example.com');
    expect(label).not.toContain('2026-04-20');
  });

  it('keeps a normal .zip extension', () => {
    expect(maskedUploadLabel(fakeFile('my-archive.zip', 1024))).toBe('upload.zip (1.0 KB)');
  });

  it('falls back to "upload" (no extension) when the filename has no dot', () => {
    expect(maskedUploadLabel(fakeFile('someblob', 500))).toBe('upload (500 B)');
  });

  it('rejects a non-alnum extension — smuggled HTML-like tail gets dropped', () => {
    const label = maskedUploadLabel(fakeFile('archive.<script>alert(1)</script>', 2048));
    expect(label).toBe('upload (2.0 KB)');
    expect(label).not.toContain('script');
    expect(label).not.toContain('alert');
  });

  it('rejects an overly-long extension that could smuggle data', () => {
    expect(maskedUploadLabel(fakeFile('file.verylongextension', 100))).toBe('upload (100 B)');
  });

  it('accepts common archive extensions up to the 5-char cap', () => {
    // tar.gz etc. — we only see the final segment (`gz`). That's fine.
    expect(maskedUploadLabel(fakeFile('x.gz', 2048))).toBe('upload.gz (2.0 KB)');
    expect(maskedUploadLabel(fakeFile('x.tar', 2048))).toBe('upload.tar (2.0 KB)');
  });

  it('handles a trailing dot (no ext chars after it) gracefully', () => {
    // `rawExt` is empty, regex rejects it, collapses to bare upload.
    expect(maskedUploadLabel(fakeFile('weird.', 10))).toBe('upload (10 B)');
  });

  it('handles zero-byte files', () => {
    expect(maskedUploadLabel(fakeFile('empty.zip', 0))).toBe('upload.zip (0 B)');
  });

  it('is tolerant of a non-string name (hostile input)', () => {
    // File.name is typed string, but we defensively guard. Simulate a
    // caller that slipped a non-string through.
    const f = new File([], 'x.zip');
    Object.defineProperty(f, 'name', { value: 123, configurable: true });
    Object.defineProperty(f, 'size', { value: 1024, configurable: true });
    expect(maskedUploadLabel(f)).toBe('upload (1.0 KB)');
  });
});

describe('formatBytes', () => {
  it('formats bytes under 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats bytes under 1 MB as KB with 1 decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2560)).toBe('2.5 KB');
  });

  it('formats bytes >= 1 MB as MB with 1 decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(27_600_000)).toBe('26.3 MB');
  });
});
