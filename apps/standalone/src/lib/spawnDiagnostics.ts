/**
 * Shared translators for Node child-process boundary errors. Lifted out
 * of `/api/mine-corrections.ts` after the review-loop flagged that ≥5
 * sibling /api routes (`mine-decisions`, `mine-narratives`,
 * `mine-persona`, `curate`, `falsify`, `rescan`) emit raw spawn-error /
 * exit-code text, and the helpful Windows-DLL-init hint had drifted
 * into three different shapes across them.
 *
 * Pure, no I/O.
 */

/**
 * Translate a Node child-process spawn `Error` into user-facing text.
 *
 * Examples in the wild:
 *   - `ENOENT: spawnfile pnpm.cmd` (Windows, claude CLI not on PATH)
 *   - `EACCES` (permission)
 *   - `EAGAIN` (resource temporarily unavailable)
 */
export function translateSpawnError(err: Error): string {
  const msg = err.message;
  if (/ENOENT/.test(msg) && /claude/i.test(msg)) {
    return 'the claude CLI was not found on PATH. Install Claude Code from https://docs.anthropic.com/claude/docs/claude-code or open a shell where `claude --version` works.';
  }
  if (/ENOENT/.test(msg)) {
    return 'a required executable was not found on PATH.';
  }
  if (/EACCES/.test(msg)) {
    return 'permission denied launching the subprocess.';
  }
  return msg;
}

/**
 * Windows abnormal-termination DLL-init failure. Node's
 * `child_process` delivers this OS-level status both as the positive
 * unsigned 32-bit value `0xC0000142` (3221225794) and as its
 * signed-int32 cast `-1073741502`, depending on path / version. Match
 * both forms.
 */
export const WINDOWS_DLL_INIT_FAILURE = 0xc0000142;
export const WINDOWS_DLL_INIT_FAILURE_NEGATIVE = -1073741502;

export function isWindowsDllInitFailure(code: number | null): boolean {
  return (
    code === WINDOWS_DLL_INIT_FAILURE ||
    code === WINDOWS_DLL_INIT_FAILURE_NEGATIVE
  );
}

/**
 * Annotate a known exit code with a one-line remediation hint. Returns
 * the empty string for unrecognized codes so callers can string-concat
 * unconditionally.
 */
export function exitCodeHint(code: number | null): string {
  if (code === null) return '';
  if (isWindowsDllInitFailure(code)) {
    return ' (Windows DLL initialization failure — usually means the Node runtime the CLI links against is broken or missing; reinstall Claude Code)';
  }
  if (code === 137) return ' (process was killed — likely out of memory)';
  if (code === 139) return ' (segmentation fault — probably a CLI bug)';
  return '';
}
