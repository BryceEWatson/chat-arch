import type { UnifiedSessionEntry } from '@chat-arch/schema';

export interface ValidationError {
  entryIndex: number;
  entryId: string;
  field: string;
  problem: string;
}

/**
 * Runtime shape-check for UnifiedSessionEntry. Not a full validator —
 * catches construction bugs (missing required fields, wrong types on
 * required-nullable) that TS would catch at call sites but that could slip
 * through JSON serialization / drift across versions.
 *
 * Zero errors expected on every run. Any error is a construction bug to
 * diagnose, not a data-quality issue to ignore.
 */
export function validateEntries(entries: readonly UnifiedSessionEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];

  const required = [
    'id',
    'source',
    'rawSessionId',
    'startedAt',
    'updatedAt',
    'durationMs',
    'title',
    'titleSource',
    'userTurns',
    'cwdKind',
  ] as const;

  const requiredNullable: ReadonlyArray<readonly [keyof UnifiedSessionEntry, 'string' | 'number']> =
    [
      ['preview', 'string'],
      ['model', 'string'],
      ['totalCostUsd', 'number'],
    ];

  entries.forEach((e, i) => {
    const rec = e as unknown as Record<string, unknown>;

    for (const k of required) {
      const v = rec[k];
      if (v === undefined) {
        errors.push({
          entryIndex: i,
          entryId: typeof rec['id'] === 'string' ? rec['id'] : '<no-id>',
          field: k,
          problem: 'required field undefined',
        });
      }
    }

    for (const [k, t] of requiredNullable) {
      const v = rec[k as string];
      if (v === undefined) {
        errors.push({
          entryIndex: i,
          entryId: typeof rec['id'] === 'string' ? rec['id'] : '<no-id>',
          field: String(k),
          problem: 'required-nullable field undefined (must be value or null)',
        });
      } else if (v !== null && typeof v !== t) {
        errors.push({
          entryIndex: i,
          entryId: typeof rec['id'] === 'string' ? rec['id'] : '<no-id>',
          field: String(k),
          problem: `expected ${t} | null, got ${typeof v}`,
        });
      }
    }
  });

  return errors;
}
