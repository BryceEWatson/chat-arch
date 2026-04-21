import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { set as idbSet } from 'idb-keyval';
import { createStore } from 'idb-keyval';
import {
  saveBenchResult,
  loadBenchResult,
  deleteBenchResult,
  listBenchResults,
  clearBenchResults,
  _resetBenchResultsStoreForTest,
  type BenchResultRow,
} from './benchResultsStore.js';

function makeRow(overrides: Partial<BenchResultRow> = {}): BenchResultRow {
  return {
    version: 1,
    configKey: 'Xenova/bge-small-en-v1.5:cls:complete-linkage:none',
    modelId: 'Xenova/bge-small-en-v1.5',
    pooling: 'cls',
    clusterConfig: 'complete-linkage',
    postproc: 'none',
    completedAt: 1_700_000_000_000,
    metrics: { classified_pct: 0.7, emergent_pct: 0.2 },
    sample: [{ clusterLabel: '~git + commit + review', size: 15 }],
    ...overrides,
  };
}

describe('benchResultsStore', () => {
  beforeEach(async () => {
    _resetBenchResultsStoreForTest();
    await clearBenchResults();
  });

  it('round-trips a row by configKey', async () => {
    const row = makeRow();
    await saveBenchResult(row);
    const read = await loadBenchResult(row.configKey);
    expect(read).not.toBeNull();
    expect(read?.configKey).toBe(row.configKey);
    expect(read?.metrics['classified_pct']).toBe(0.7);
  });

  it('does not persist session titles in the sample block', async () => {
    // Contract: the persisted row must only carry {clusterLabel, size}
    // in each sample entry. Session titles are user-authored PII and
    // must not sit in IDB indefinitely next to a developer-only
    // benchmark config. See `pickSample` in BenchmarkRunner.tsx.
    const row = makeRow();
    await saveBenchResult(row);
    const read = await loadBenchResult(row.configKey);
    expect(read).not.toBeNull();
    for (const entry of read!.sample) {
      expect(Object.keys(entry).sort()).toEqual(['clusterLabel', 'size']);
      expect('memberTitles' in entry).toBe(false);
    }
  });

  it('returns null for an unknown configKey', async () => {
    const read = await loadBenchResult('no-such:config:key:nope');
    expect(read).toBeNull();
  });

  it('lists results sorted by completedAt ascending', async () => {
    await saveBenchResult(makeRow({ configKey: 'b:cls:c:p', completedAt: 2_000_000 }));
    await saveBenchResult(makeRow({ configKey: 'a:cls:c:p', completedAt: 1_000_000 }));
    const list = await listBenchResults();
    expect(list.map((r) => r.configKey)).toEqual(['a:cls:c:p', 'b:cls:c:p']);
  });

  it('delete removes a row without affecting others', async () => {
    await saveBenchResult(makeRow({ configKey: 'keep:cls:c:p' }));
    await saveBenchResult(makeRow({ configKey: 'drop:cls:c:p' }));
    await deleteBenchResult('drop:cls:c:p');
    const list = await listBenchResults();
    expect(list.map((r) => r.configKey)).toEqual(['keep:cls:c:p']);
  });

  describe('legacy row migration', () => {
    // Any row persisted by a pre-security-review build carries a
    // `memberTitles` array alongside `clusterLabel`/`size` on each
    // sample entry. Those rows predate the schema tightening and
    // hold raw session titles. On the next load they must be
    // invisible to callers AND physically deleted from IndexedDB so
    // the PII stops sitting at rest.

    it('loadBenchResult returns null for a legacy row that still carries memberTitles', async () => {
      // Bypass saveBenchResult to plant a pre-upgrade shape directly.
      const store = createStore('chat-arch-bench-results', 'bench-results');
      const legacyRow = {
        version: 1,
        configKey: 'legacy:cls:c:p',
        modelId: 'Xenova/bge-small-en-v1.5',
        pooling: 'cls',
        clusterConfig: 'complete-linkage',
        postproc: 'none',
        completedAt: 1_700_000_000_000,
        metrics: { classified_pct: 0.7 },
        sample: [
          {
            clusterLabel: '~git + commit',
            size: 3,
            memberTitles: [
              'Helping Bob debug his Postgres migration',
              'Kick-off call notes from 2025-09-12',
              'Draft reply to Alice re: Q4 planning',
            ],
          },
        ],
      };
      await idbSet('legacy:cls:c:p', legacyRow, store);

      const read = await loadBenchResult('legacy:cls:c:p');
      expect(read).toBeNull();
    });

    it('listBenchResults hides legacy rows AND deletes them from IDB', async () => {
      const store = createStore('chat-arch-bench-results', 'bench-results');

      // One legacy row (memberTitles present) + one clean row.
      await idbSet(
        'legacy:cls:c:p',
        {
          version: 1,
          configKey: 'legacy:cls:c:p',
          modelId: 'm',
          pooling: 'cls',
          clusterConfig: 'c',
          postproc: 'p',
          completedAt: 1_000,
          metrics: {},
          sample: [{ clusterLabel: '~x', size: 2, memberTitles: ['leaked title'] }],
        },
        store,
      );
      await saveBenchResult(makeRow({ configKey: 'clean:cls:c:p' }));

      const first = await listBenchResults();
      expect(first.map((r) => r.configKey)).toEqual(['clean:cls:c:p']);

      // Second scan: the legacy row should be gone from IDB. Reset
      // the cached store handle to force a fresh open against the
      // on-disk state.
      _resetBenchResultsStoreForTest();
      const second = await listBenchResults();
      expect(second.map((r) => r.configKey)).toEqual(['clean:cls:c:p']);

      // Direct probe: the legacy key should no longer resolve.
      expect(await loadBenchResult('legacy:cls:c:p')).toBeNull();
    });
  });
});
