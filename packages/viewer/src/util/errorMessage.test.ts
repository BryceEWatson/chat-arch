import { describe, it, expect } from 'vitest';
import { errorToUserMessage } from './errorMessage.js';

describe('errorToUserMessage', () => {
  it('translates "Failed to fetch" into a backend-not-reachable message', () => {
    const out = errorToUserMessage(new Error('Failed to fetch'));
    expect(out).toMatch(/local backend isn't reachable/i);
  });

  it('translates mobile-Safari "Load failed" similarly', () => {
    const out = errorToUserMessage(new Error('Load failed'));
    expect(out).toMatch(/local backend isn't reachable/i);
  });

  it('translates HTTP 500 with a server-side-error hint', () => {
    const out = errorToUserMessage(new Error('HTTP 500'));
    expect(out).toMatch(/server hit an internal error/i);
  });

  it('translates "status 404" with a missing-endpoint hint', () => {
    const out = errorToUserMessage(new Error('apply-correction failed (status 404)'));
    expect(out).toMatch(/couldn't find what was requested/i);
  });

  it('strips internal /api/... paths from arbitrary messages', () => {
    const out = errorToUserMessage(
      new Error('network error contacting /api/chat-answer: timeout'),
    );
    expect(out).not.toMatch(/\/api\/chat-answer/);
    expect(out).toMatch(/the local backend/i);
  });

  it('prefixes with context when supplied', () => {
    const out = errorToUserMessage(new Error('HTTP 500'), {
      context: 'apply the correction',
    });
    expect(out).toMatch(/^Couldn't apply the correction/);
  });

  it('falls back to the raw message when nothing matches', () => {
    expect(errorToUserMessage(new Error('thing broke'))).toMatch(/thing broke/);
  });

  it('handles non-Error throws (string / number / unknown)', () => {
    expect(errorToUserMessage('just a string')).toMatch(/just a string/);
    expect(errorToUserMessage(undefined)).toMatch(/Unknown error/);
    expect(errorToUserMessage(null)).toMatch(/Unknown error/);
  });
});
