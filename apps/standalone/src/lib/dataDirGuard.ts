import { resolve, sep } from 'node:path';

/**
 * The only directory tree the rescan / mine / export endpoints are
 * allowed to read and write. User-supplied `dataDir` strings from POST
 * bodies must resolve into this tree; anything outside is path
 * traversal (S1 in the PR #53 adversarial review).
 *
 * Relative to repoRoot.
 */
export const SAFE_DATA_ROOT_REL = 'apps/standalone/public/chat-arch-data';

export class DataDirGuardError extends Error {
  constructor(public readonly attempted: string) {
    super(`dataDir resolved outside the safe root: ${attempted}`);
    this.name = 'DataDirGuardError';
  }
}

/**
 * Resolve `candidate` against `repoRoot` and verify it lands inside
 * (or equal to) the chat-arch-data safe root. Returns the validated
 * absolute path; throws `DataDirGuardError` otherwise.
 *
 * Callers should convert the thrown error into a 400 response — the
 * endpoints are localhost-CSRF-gated, but a successful traversal would
 * still let a malicious local origin read or write under the repo.
 */
export function assertDataDirContained(
  candidate: string,
  repoRoot: string,
): string {
  const safeRoot = resolve(repoRoot, SAFE_DATA_ROOT_REL);
  const resolved = resolve(repoRoot, candidate);
  if (resolved !== safeRoot && !resolved.startsWith(safeRoot + sep)) {
    throw new DataDirGuardError(resolved);
  }
  return resolved;
}

/**
 * Convert a `DataDirGuardError` into a 400 JSON Response. Returns
 * `null` for any other error so the caller can re-throw / propagate
 * via its existing flow.
 *
 * Extracted from 4 copy-pasted callsites flagged by iter-2 review
 * (XN2). The response shape is intentionally a static "escapes the
 * safe root" message — never echo the attempted path back to the
 * caller (avoids leaking absolute paths to a malicious origin).
 */
export function handleDataDirGuardError(err: unknown): Response | null {
  if (err instanceof DataDirGuardError) {
    return new Response(
      JSON.stringify({ ok: false, error: 'dataDir escapes the chat-arch-data safe root' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
  return null;
}
