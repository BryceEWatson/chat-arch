/**
 * Fixed-size worker pool for running an async task over a list of items.
 *
 * Extracted from `sources/cowork.ts` (Phase 2) in Phase 3 so both the Cowork
 * manifest walker and the CLI transcript walker share the exact same semantics:
 *
 *  - At most `limit` task invocations run in parallel.
 *  - Items are consumed in order by whichever worker is free; ordering of
 *    `task(item)` completion is NOT guaranteed.
 *  - The outer promise resolves when every item has completed (or rejects on
 *    the first task rejection — callers that want per-item tolerance should
 *    swallow errors inside `task`).
 *  - When `items.length < limit`, only `items.length` workers are spawned
 *    (no wasted pending promises).
 *
 * Pure refactor — zero behavior change vs. Phase 2's private copy.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const total = items.length;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= total) return;
      const item = items[idx] as T;
      await task(item);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, total); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}
