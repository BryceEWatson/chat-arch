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
      | 'traversal',
  ) {
    super(message);
    this.name = 'WorkingDirError';
  }
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
  const sep = path.sep;
  const root = workingDir.absolute;
  const isContained =
    resolved === root || resolved.startsWith(root + sep);
  if (!isContained) {
    throw new WorkingDirError(
      `Path escapes working directory. Candidate "${candidate}" resolved to "${resolved}", which is not within "${root}".`,
      'traversal',
    );
  }
  return resolved;
}
