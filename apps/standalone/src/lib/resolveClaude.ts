import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the `claude` (Claude Code CLI) binary path for `spawn()`.
 *
 * Background — why this exists:
 *
 *   On Windows, the typical Claude Code install path is a global npm
 *   shim at e.g. `C:\nvm4w\nodejs\claude.cmd` that delegates to
 *   `node_modules\@anthropic-ai\claude-code\bin\claude.exe`. Claude
 *   Code's auto-updater rotates the `.exe` (renaming the prior to
 *   `claude.exe.old.<ts>`) and replaces it in-place. If the update is
 *   mid-flight, fails, or the new binary is being held open by a still-
 *   running process, the `bin/` directory can be left with only the
 *   rotated `.old` files — no current `.exe`. Every `spawn('claude',
 *   …, { shell: true })` then errors with
 *   "'…\claude.exe' is not recognized as an internal or external
 *   command" and exits 1 before producing any output.
 *
 *   Meanwhile a working local install lives alongside the user data at
 *   `%APPDATA%\Claude\claude-code\<version>\claude.exe` (Claude Code's
 *   version-managed cache). This is the install the running Claude
 *   Code processes are actually executing from on a broken-shim
 *   machine, but `spawn('claude', …)` doesn't reach it because the
 *   shell's PATH lookup finds the broken shim first.
 *
 * Resolution order (first hit wins):
 *
 *   1. `process.env.CLAUDE_BIN` — explicit operator override. Must
 *      point at a file that exists; otherwise fall through.
 *   2. `process.env.CLAUDE_CODE_EXECPATH` — set by the Claude Code
 *      harness/VS Code extension to the binary running the current
 *      session. The most reliable signal when the dev server is
 *      launched from a Claude Code shell: it points at whatever
 *      install is actively in use (VS Code embedded, portable, etc.).
 *   3. (Windows only) `%APPDATA%\Claude\claude-code\<version>\
 *      claude.exe` — pick the newest version directory by semver.
 *      Falls through if APPDATA is unset or the directory tree is
 *      absent.
 *   4. Bare `'claude'` — PATH-resolved by the shell (the original
 *      behavior). Works when the global shim is healthy.
 *
 *   The shape returned tells the caller whether to set `shell: true`
 *   on the spawn: when we resolved a concrete `.exe` path,
 *   `shell: false` is preferable so the absolute path bypasses cmd's
 *   special-char handling entirely. When falling back to the bare
 *   `'claude'`, `shell: true` is still required on Windows so the
 *   shim's `.cmd` extension gets PATHEXT-resolved.
 */
export interface ClaudeBin {
  /** Absolute path or bare command name passed as `spawn(file, …)`. */
  file: string;
  /** Pass to `spawn(file, args, { shell: useShell })`. */
  useShell: boolean;
  /** Tag describing which strategy hit, for logging. */
  source: 'env' | 'execpath' | 'appdata' | 'path';
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Walk `%APPDATA%\Claude\claude-code\*` and return the directory whose
 * name semver-sorts highest among entries that contain a `claude.exe`.
 * Null when the tree is missing or no version directory holds a real
 * binary.
 *
 * We compare versions by splitting on `.` and numeric-comparing each
 * segment so `2.1.138` correctly beats `2.1.99` (which a plain lexical
 * sort would invert).
 */
function pickNewestAppdataInstall(appdata: string): string | null {
  const root = join(appdata, 'Claude', 'claude-code');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const candidates: { dir: string; parts: number[] }[] = [];
  for (const name of entries) {
    const exe = join(root, name, 'claude.exe');
    if (!fileExists(exe)) continue;
    const parts = name
      .split('.')
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
    if (parts.length === 0) continue;
    candidates.push({ dir: join(root, name), parts });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const len = Math.max(a.parts.length, b.parts.length);
    for (let i = 0; i < len; i++) {
      const ai = a.parts[i] ?? 0;
      const bi = b.parts[i] ?? 0;
      if (ai !== bi) return bi - ai;
    }
    return 0;
  });
  return join(candidates[0]!.dir, 'claude.exe');
}

export function resolveClaudeBin(): ClaudeBin {
  const envBin = process.env['CLAUDE_BIN'];
  if (typeof envBin === 'string' && envBin.length > 0 && fileExists(envBin)) {
    return { file: envBin, useShell: false, source: 'env' };
  }

  // Claude Code / VS Code extension sets this to the binary running the
  // current session. When the dev server is launched from inside a
  // Claude Code shell (the normal workflow), this is the most reliable
  // pointer at a working install — bypasses any broken PATH shim.
  const execPath = process.env['CLAUDE_CODE_EXECPATH'];
  if (typeof execPath === 'string' && execPath.length > 0 && fileExists(execPath)) {
    return { file: execPath, useShell: false, source: 'execpath' };
  }

  if (process.platform === 'win32') {
    const appdata = process.env['APPDATA'];
    if (typeof appdata === 'string' && appdata.length > 0) {
      const found = pickNewestAppdataInstall(appdata);
      if (found && fileExists(found)) {
        return { file: found, useShell: false, source: 'appdata' };
      }
    }
  }

  // Last-resort fallback — let the shell find it via PATH. This is the
  // original behavior and still works on machines whose global shim is
  // healthy. On a broken-shim machine the spawn will surface a clear
  // error that points the operator at the env-var override.
  return {
    file: 'claude',
    useShell: process.platform === 'win32',
    source: 'path',
  };
}
