import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigDocumentKind, ConfigDocumentSource } from '@chat-arch/schema';

export interface DiscoveredPath {
  path: string;
  source: ConfigDocumentSource;
  kind: ConfigDocumentKind;
  projectRoot?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') return [];
    throw err;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function discoverInRoot(
  root: string,
  source: ConfigDocumentSource,
  projectRoot: string | undefined,
): Promise<DiscoveredPath[]> {
  const out: DiscoveredPath[] = [];

  const skillsDir = path.join(root, 'skills');
  if (await isDir(skillsDir)) {
    const entries = await safeReaddir(skillsDir);
    for (const entry of entries) {
      const skillFile = path.join(skillsDir, entry, 'SKILL.md');
      if (await isFile(skillFile)) {
        out.push({
          path: skillFile,
          source,
          kind: 'skill',
          ...(projectRoot !== undefined ? { projectRoot } : {}),
        });
      }
    }
  }

  const agentsDir = path.join(root, 'agents');
  if (await isDir(agentsDir)) {
    const entries = await safeReaddir(agentsDir);
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const file = path.join(agentsDir, entry);
      if (await isFile(file)) {
        out.push({
          path: file,
          source,
          kind: 'agent',
          ...(projectRoot !== undefined ? { projectRoot } : {}),
        });
      }
    }
  }

  const commandsDir = path.join(root, 'commands');
  if (await isDir(commandsDir)) {
    const entries = await safeReaddir(commandsDir);
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const file = path.join(commandsDir, entry);
      if (await isFile(file)) {
        out.push({
          path: file,
          source,
          kind: 'command',
          ...(projectRoot !== undefined ? { projectRoot } : {}),
        });
      }
    }
  }

  const settingsPath = path.join(root, 'settings.json');
  if (await isFile(settingsPath)) {
    out.push({
      path: settingsPath,
      source,
      kind: 'settings',
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    });
  }

  if (source === 'project') {
    const localSettings = path.join(root, 'settings.local.json');
    if (await isFile(localSettings)) {
      out.push({
        path: localSettings,
        source,
        kind: 'settings',
        ...(projectRoot !== undefined ? { projectRoot } : {}),
      });
    }
  }

  return out;
}

export async function discoverConfigPaths(
  globalRoot: string,
  projectRoots: readonly string[],
): Promise<DiscoveredPath[]> {
  const out: DiscoveredPath[] = [];

  if (await exists(globalRoot)) {
    const globalClaudeMd = path.join(globalRoot, 'CLAUDE.md');
    if (await isFile(globalClaudeMd)) {
      out.push({ path: globalClaudeMd, source: 'global', kind: 'claude-md' });
    }
    const globalDocs = await discoverInRoot(globalRoot, 'global', undefined);
    out.push(...globalDocs);
  }

  for (const projectRoot of projectRoots) {
    const projectClaudeMd = path.join(projectRoot, 'CLAUDE.md');
    if (await isFile(projectClaudeMd)) {
      out.push({
        path: projectClaudeMd,
        source: 'project',
        kind: 'claude-md',
        projectRoot,
      });
    }
    const projectClaudeDir = path.join(projectRoot, '.claude');
    if (await isDir(projectClaudeDir)) {
      const projectDocs = await discoverInRoot(projectClaudeDir, 'project', projectRoot);
      out.push(...projectDocs);
    }
  }

  return out;
}
