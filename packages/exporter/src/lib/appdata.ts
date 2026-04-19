import path from 'node:path';

/**
 * Resolve the root of the Claude AppData tree on Windows.
 *
 * Uses `%APPDATA%\Claude` (`C:/Users/<you>/AppData/Roaming/Claude`). On
 * non-Windows systems this throws a readable error because the Phase 2
 * sources only exist on Windows.
 */
export function resolveAppDataClaudeRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') {
    throw new Error(
      `[chat-arch] Cowork/Desktop-CLI sources only exist on Windows; detected platform=${process.platform}`,
    );
  }
  const appData = env['APPDATA'];
  if (!appData) {
    throw new Error(
      '[chat-arch] APPDATA environment variable is not set; cannot locate Claude AppData root',
    );
  }
  return path.join(appData, 'Claude');
}
