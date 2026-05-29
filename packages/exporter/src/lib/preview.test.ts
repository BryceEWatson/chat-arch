import { describe, it, expect } from 'vitest';
import { buildPreview } from './preview.js';

describe('buildPreview', () => {
  it('returns null for null / undefined / empty input', () => {
    expect(buildPreview(null)).toBeNull();
    expect(buildPreview(undefined)).toBeNull();
    expect(buildPreview('')).toBeNull();
    expect(buildPreview('   ')).toBeNull();
  });

  it('passes plain text through (trimmed + whitespace-collapsed)', () => {
    expect(buildPreview('  hello   world  ')).toBe('hello world');
  });

  it('truncates to 200 chars', () => {
    const input = 'x'.repeat(300);
    expect(buildPreview(input)?.length).toBe(200);
  });

  it('unwraps a slash-command envelope into "/name args"', () => {
    const raw = [
      '<command-message>loop</command-message>',
      '<command-name>/loop</command-name>',
      '<command-args>fix the auth bug</command-args>',
    ].join('\n');
    expect(buildPreview(raw)).toBe('/loop fix the auth bug');
  });

  it('unwraps a scheduled-task envelope', () => {
    expect(
      buildPreview('<scheduled-task name="nightly-rescan">payload</scheduled-task>'),
    ).toBe('↻ scheduled-task: nightly-rescan');
  });

  it('drops <system-reminder> blocks and returns null when nothing else remains', () => {
    const raw = '<system-reminder>tool list updated</system-reminder>';
    expect(buildPreview(raw)).toBeNull();
  });
});
