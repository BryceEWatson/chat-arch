// Tiny helper to build `SET col = ?, col = ?, ...` clauses from a
// patch object. Eliminates the per-entity `if (patch.x !== undefined)
// { sets.push(...); args.push(...) }` chain that was repeated across
// every Update<Entity> path. Per iter-1 simplicity review #1.
//
// Callers pre-transform values that need a runtime shape change
// (e.g. booleans → 0/1 in patterns.ts) before passing the patch; this
// helper stays purely about column-name routing.

/**
 * Given a partial patch and a `<input-key, sql-column>` map, return
 * the `sets` and `args` arrays a prepared-statement builder needs.
 *
 * Keys present in `patch` with `undefined` value are skipped (treated
 * as "no change"); `null` is forwarded as a real value (used to clear
 * a nullable column).
 */
export function buildUpdateSets<TPatch extends object>(
  patch: TPatch,
  columnMap: Readonly<Record<keyof TPatch, string>>,
): { readonly sets: readonly string[]; readonly args: readonly unknown[] } {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const key in columnMap) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) {
      sets.push(`${columnMap[key]} = ?`);
      args.push(value);
    }
  }
  return { sets, args };
}
