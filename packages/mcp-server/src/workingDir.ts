// Phase Rev3-H H2 — working-dir scoping.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase
// Rev3-H H2:
//
//   "Read-only by default; narrow tool surface (no arbitrary
//    readFile, no `claude -p` exec from server, working-dir scoped
//    to chat-arch-data/)."
//
// This module owns ONE pure decision: given a user-supplied
// candidate working directory, is it (a) an absolute path,
// (b) basename `chat-arch-data` so the server can't be pointed at
// a developer's home directory or `/etc`?
//
// Path validation lives here rather than inside the server factory
// so the server's invariants are testable as pure functions and so
// every downstream code path can call `assertPathWithinWorkingDir`
// before opening a file. The actual filesystem existence check is
// a separate concern (caller's job) — this module is policy, not
// I/O.

import * as path from 'node:path';

export interface WorkingDir {
  /** Absolute, normalized path to the working directory. */
  readonly absolute: string;
}

export class WorkingDirError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not-absolute'
      | 'wrong-basename'
      | 'empty'
      | 'traversal'
      | 'network-path',
  ) {
    super(message);
    this.name = 'WorkingDirError';
  }
}

/**
 * Normalize a Windows path for case-insensitive comparison.
 *
 * On Windows, `path.resolve` preserves the literal drive-letter
 * case the caller supplied — but NTFS treats `C:\` and `c:\` as
 * identical at the filesystem level. Without this normalization,
 * a working dir registered as `C:\...\chat-arch-data` would
 * REJECT a legitimate candidate path supplied as `c:\...\chat-
 * arch-data\foo.json` (and the inverse). Both an availability bug
 * AND a containment-policy / filesystem-truth mismatch — a caller
 * able to choose case could craft escape variants that test as
 * "outside" lexically but hit the same files at the OS layer.
 *
 * POSIX paths are returned unchanged (case-sensitive filesystems).
 * Per adversarial review on PR #93.
 */
function normalizeForCompare(p: string): string {
  if (process.platform !== 'win32') return p;
  // Windows: uppercase the drive letter, then lowercase the rest
  // (NTFS is case-insensitive for both drive and path components).
  if (p.length >= 2 && p.charAt(1) === ':') {
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  }
  return p.toLowerCase();
}

/**
 * Resolve a candidate working-dir string into a validated
 * `WorkingDir`. Validation rules:
 *
 *   1. Non-empty after trim.
 *   2. Absolute path (rejects relative + bare names — the server is
 *      launched without an assumed `process.cwd()` context).
 *   3. Basename === `chat-arch-data` (rejects pointing the server
 *      at `/`, `~`, or any other directory).
 *
 * The actual `lstat`/`exists` check is the CALLER'S job — this
 * module is policy. We don't want to mix `node:fs` I/O into a pure
 * decision so the rules can be tested as a pure function.
 */
export function resolveWorkingDir(input: string): WorkingDir {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new WorkingDirError(
      'Working directory cannot be empty.',
      'empty',
    );
  }
  if (!path.isAbsolute(trimmed)) {
    throw new WorkingDirError(
      `Working directory must be an absolute path. Got: "${input}".`,
      'not-absolute',
    );
  }
  // Reject Windows UNC paths (`\\server\share\...`). Their trust
  // model is fundamentally different from local FS paths: network
  // MITM, share-level ACLs vs local-FS ACLs, transient
  // unavailability mid-query. If H3 wants to support network
  // shares, this must be a separate, deliberate decision with its
  // own threat model — not an accidental side-effect of resolve.
  // Per adversarial review on PR #93.
  if (process.platform === 'win32' && /^\\\\/.test(trimmed)) {
    throw new WorkingDirError(
      `Working directory cannot be a UNC / network path. Got: "${input}".`,
      'network-path',
    );
  }
  const normalized = path.resolve(trimmed);
  const base = path.basename(normalized);
  if (base !== 'chat-arch-data') {
    throw new WorkingDirError(
      `Working directory basename must be "chat-arch-data". Got: "${base}" (full path: "${normalized}").`,
      'wrong-basename',
    );
  }
  return { absolute: normalized };
}

/**
 * Assert that a candidate child path resolves under the working
 * directory — no `..` traversal escapes, no absolute path pointing
 * elsewhere, no symlink games (within the lexical resolution; an
 * actual symlink-following check requires `realpath` and belongs
 * at the I/O boundary).
 *
 * Throws `WorkingDirError` with code `'traversal'` on violation.
 *
 * **First production caller lands in H3** (the SDK query tools that
 * open analysis-sidecar files inside `chat-arch-data/`). Tested as
 * a pure function here so the policy is locked before the protocol
 * layer plugs in. Per simplicity-review note on PR #93.
 */
export function assertPathWithinWorkingDir(
  workingDir: WorkingDir,
  candidate: string,
): string {
  const trimmed = candidate.trim();
  if (trimmed === '') {
    throw new WorkingDirError(
      'Path cannot be empty.',
      'empty',
    );
  }
  // Resolve candidate relative to the working dir (so callers can
  // pass either "narratives/foo.json" or an absolute path).
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workingDir.absolute, trimmed);
  // Lexical containment: `resolved` must equal workingDir.absolute
  // OR start with `workingDir.absolute + path.sep`. Avoid the
  // common bug of `startsWith(workingDir)` without the trailing
  // sep (which would accept `/foo/chat-arch-data-evil`).
  //
  // On Windows, normalize both sides to canonical case before
  // compare — NTFS treats `C:\` and `c:\` as identical, so a
  // case-mismatched candidate must NOT be rejected as "outside".
  // See `normalizeForCompare` for full rationale.
  const sep = path.sep;
  const root = workingDir.absolute;
  const resolvedN = normalizeForCompare(resolved);
  const rootN = normalizeForCompare(root);
  const isContained =
    resolvedN === rootN || resolvedN.startsWith(rootN + sep);
  if (!isContained) {
    throw new WorkingDirError(
      `Path escapes working directory. Candidate "${candidate}" resolved to "${resolved}", which is not within "${root}".`,
      'traversal',
    );
  }
  return resolved;
}
