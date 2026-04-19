import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findRepoRoot, _resetRepoRootCacheForTests } from '../../src/lib/repo-root.js';

describe('findRepoRoot', () => {
  beforeEach(() => {
    _resetRepoRootCacheForTests();
  });

  it('locates the workspace root by finding pnpm-workspace.yaml', () => {
    const root = findRepoRoot();
    expect(existsSync(path.join(root, 'pnpm-workspace.yaml'))).toBe(true);
    expect(existsSync(path.join(root, 'packages', 'exporter'))).toBe(true);
  });

  it('memoizes the result across calls', () => {
    const a = findRepoRoot();
    const b = findRepoRoot();
    expect(a).toBe(b);
  });
});
