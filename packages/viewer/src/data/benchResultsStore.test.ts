import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
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
    sample: [{ clusterLabel: '~git + commit + review', size: 15, memberTitles: [] }],
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

  it('returns null for an unknown configKey', async () => {
    const read = await loadBenchResult('no-such:config:key:nope');
    expect(read).toBeNull();
  });

  it('lists results sorted by completedAt ascending', async () => {
    await saveBenchResult(
      makeRow({ configKey: 'b:cls:c:p', completedAt: 2_000_000 }),
    );
    await saveBenchResult(
      makeRow({ configKey: 'a:cls:c:p', completedAt: 1_000_000 }),
    );
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
});
