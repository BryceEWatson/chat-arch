// Typed error classes for the chat-arch SQLite SDK.
//
// `NotFoundError` lets callers distinguish "entity didn't exist" from
// other failure modes without sniffing for `null` returns or parsing
// better-sqlite3 error messages.
//
// `UniqueViolationError` wraps SQLite's `SQLITE_CONSTRAINT_PRIMARYKEY`
// + `SQLITE_CONSTRAINT_UNIQUE` so callers can implement upsert-or-fail
// flows without code-sniffing.

export class NotFoundError extends Error {
  readonly entity: string;
  readonly key: unknown;
  constructor(entity: string, key: unknown) {
    super(`${entity} not found: ${JSON.stringify(key)}`);
    this.name = 'NotFoundError';
    this.entity = entity;
    this.key = key;
  }
}

export class UniqueViolationError extends Error {
  readonly entity: string;
  readonly key: unknown;
  constructor(entity: string, key: unknown, cause?: unknown) {
    super(`${entity} unique violation: ${JSON.stringify(key)}`);
    this.name = 'UniqueViolationError';
    this.entity = entity;
    this.key = key;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** True for SQLite's uniqueness-class constraint codes. */
export function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
