/**
 * Server-side reader for the playbook sidecar. Used by the /playbook
 * page at request-time (`export const prerender = false`).
 *
 * Kept narrowly scoped to playbook-candidates.json so this file can land
 * before the broader `readSidecars.ts` helper (which arrives with the
 * audit/results work on a different branch). When that helper lands, we
 * can fold this reader into it without changing the page's import shape.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlaybookCandidatesFile } from '@chat-arch/schema';

function dataRoot(): string {
  return path.join(
    process.cwd(),
    'apps',
    'standalone',
    'public',
    'chat-arch-data',
  );
}

export async function readPlaybookCandidates(): Promise<PlaybookCandidatesFile | null> {
  const p = path.join(dataRoot(), 'analysis', 'playbook-candidates.json');
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as PlaybookCandidatesFile;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}
