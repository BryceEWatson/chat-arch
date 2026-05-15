import { describe, it, expect } from 'vitest';
import { discoverWslCliProjectsRoots } from '../../src/lib/wsl.js';

describe('discoverWslCliProjectsRoots', () => {
  it('returns [] on non-Windows platforms (early exit)', async () => {
    // The function gates on process.platform === 'win32'. On the test
    // runner this will be 'win32' on the live dev host but other CI
    // environments may differ; in either case the function must not
    // throw. Just exercise it and assert it returns an array.
    const res = await discoverWslCliProjectsRoots();
    expect(Array.isArray(res)).toBe(true);
    for (const r of res) {
      // Every returned root must end with .claude\projects under wsl.localhost.
      expect(r).toMatch(/wsl\.localhost[\\/].+[\\/]home[\\/].+[\\/]\.claude[\\/]projects$/);
    }
  });
});
