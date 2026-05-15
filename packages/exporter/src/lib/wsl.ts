import { execFileSync } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Enumerate Windows-side CLI projects roots that live inside WSL distros.
 *
 * Returns absolute UNC paths of the form
 *   `\\wsl.localhost\<distro>\home\<user>\.claude\projects`
 * for every (distro, user) pair where that directory exists.
 *
 * Strategy:
 *   1. Discover distros via `wsl --list --quiet` (UTF-16LE output, with a
 *      blank-line / "Windows Subsystem" header that must be stripped).
 *   2. Skip system distros (`docker-desktop` and friends) that never host
 *      user Claude Code installs — checking them costs a stat per user
 *      and they always return empty.
 *   3. For each remaining distro, enumerate `\\wsl.localhost\<distro>\home`
 *      and look for a `.claude/projects` dir under each user. UNC reads
 *      work transparently from Windows node — verified empirically.
 *
 * Best-effort: any failure (no WSL installed, distro unreachable, perm
 * errors) returns `[]` with a single warn-once. Never throws.
 */
export async function discoverWslCliProjectsRoots(): Promise<readonly string[]> {
  if (process.platform !== 'win32') return [];

  let distros: readonly string[];
  try {
    distros = listWslDistros();
  } catch (err) {
    logger.warnOnce(
      'wsl-list-failed',
      `[chat-arch] could not enumerate WSL distros (${(err as Error).message}); skipping WSL CLI scan`,
    );
    return [];
  }

  const roots: string[] = [];
  for (const distro of distros) {
    if (SYSTEM_DISTROS.has(distro)) continue;
    const homeRoot = `\\\\wsl.localhost\\${distro}\\home`;
    let users: readonly string[];
    try {
      users = await readdir(homeRoot);
    } catch {
      // Distro unreachable or no /home — skip silently.
      continue;
    }
    for (const user of users) {
      const projectsRoot = path.join(homeRoot, user, '.claude', 'projects');
      try {
        const st = await stat(projectsRoot);
        if (st.isDirectory()) roots.push(projectsRoot);
      } catch {
        // No projects dir for this user — skip silently.
      }
    }
  }
  return roots;
}

/**
 * System WSL distros that never carry user Claude Code data. Skipping
 * them avoids spinning up Docker's WSL2 instance just to fail on `/home`.
 */
const SYSTEM_DISTROS = new Set<string>(['docker-desktop', 'docker-desktop-data']);

/**
 * Parse `wsl --list --quiet` output. Windows ships the output as
 * UTF-16LE-encoded text with stray nulls on some hosts; we decode and
 * strip non-printable characters, then drop empty lines and the legacy
 * "Windows Subsystem for Linux Distributions:" header.
 *
 * Exported for tests; production callers should use the async wrapper.
 */
export function listWslDistros(): readonly string[] {
  const buf = execFileSync('wsl.exe', ['--list', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // wsl.exe emits UTF-16LE; decode and normalize.
  const text = buf.toString('utf16le').replace(/\0/g, '');
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('Windows Subsystem'))
    // The default distro line carries a leading "*" in some locales,
    // and may bracket the name with "(Default)". Normalize away.
    .map((s) => s.replace(/^\*\s*/, '').replace(/\s*\(Default\)\s*$/, '').trim())
    .filter((s) => s.length > 0);
}
