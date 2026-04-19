import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry, SessionSource } from './unified.js';
import { UNTITLED_SESSION } from './unified.js';

describe('UnifiedSessionEntry type-level sanity', () => {
  it('accepts a minimal cloud entry', () => {
    const e: UnifiedSessionEntry = {
      id: 'abc',
      source: 'cloud',
      rawSessionId: 'abc',
      startedAt: 0,
      updatedAt: 0,
      durationMs: 0,
      title: UNTITLED_SESSION,
      titleSource: 'fallback',
      preview: null,
      userTurns: 0,
      model: null,
      cwdKind: 'none',
      totalCostUsd: null,
    };
    expect(e.source).toBe('cloud');
  });

  it('accepts a minimal cowork entry with cost and cwd', () => {
    const e: UnifiedSessionEntry = {
      id: 'u',
      source: 'cowork',
      rawSessionId: 'local_u',
      startedAt: 1,
      updatedAt: 2,
      durationMs: 1,
      title: 'x',
      titleSource: 'manifest',
      preview: null,
      userTurns: 1,
      model: 'claude-opus-4-6',
      cwdKind: 'vm',
      totalCostUsd: 0.5,
      cwd: '/sessions/foo',
    };
    expect(e.source).toBe('cowork');
  });

  it('narrows SessionSource exhaustively', () => {
    const sources: SessionSource[] = ['cloud', 'cowork', 'cli-direct', 'cli-desktop'];
    expect(sources).toHaveLength(4);
  });

  it('accepts the conditional-spread pattern for optional cwd under exactOptionalPropertyTypes', () => {
    const cwd: string | undefined = 'C:\\Users\\example\\Projects\\chat-arch';
    const e: UnifiedSessionEntry = {
      id: 'a',
      source: 'cli-direct',
      rawSessionId: 'a',
      startedAt: 0,
      updatedAt: 0,
      durationMs: 0,
      title: 'x',
      titleSource: 'fallback',
      preview: null,
      userTurns: 0,
      model: null,
      cwdKind: 'host',
      totalCostUsd: null,
      ...(cwd !== undefined ? { cwd } : {}),
    };
    expect(e.cwd).toBe(cwd);
  });
});
