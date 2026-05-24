// Data-dir wipe helpers, factored out of `/api/clear` so they can be
// unit-tested without standing up the full Astro request pipeline.
//
// Rev3-A.A9 (orphan-sweep): the kitchen-sink wipe already removes
// everything under `chat-arch-data/` except `.gitkeep`, which means
// the future SQLite DB family (`*.db`, `*.db-wal`, `*.db-shm`) and
// orphan JSON sidecars under `analysis/` are swept on the same code
// path. The partial-source wipe always removes the `analysis/`
// subdirectory — those files are derived from the manifest and stale
// the moment any session disappears.
//
// Forward-compat note (Rev3): once the SQLite SDK (A8) starts writing
// to `chat-arch-data/chat-arch.db`, the kitchen-sink wipe handles it
// automatically (covered by the `name !== .gitkeep` filter). For
// partial-source deletes, the SDK will need its own row-level delete
// path (DELETE FROM sessions WHERE source = ?) — but that lands with
// the SDK in A8, not here.

import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const ALL_SOURCES = [
  'cli-direct',
  'cli-desktop',
  'cowork',
  'cloud',
] as const;
export type SourceName = (typeof ALL_SOURCES)[number];

export interface ManifestSession {
  id: string;
  source: string;
  transcriptPath?: string;
  [k: string]: unknown;
}

export interface Manifest {
  schemaVersion: number;
  generatedAt: number;
  counts: Record<string, number>;
  sessions: ManifestSession[];
}

export async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const m = JSON.parse(raw) as Manifest;
    if (!m || !Array.isArray(m.sessions)) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Kitchen-sink mode — wipe the entire data dir except `.gitkeep`.
 *
 * Sweeps in one pass:
 *   - `manifest.json` (current source of truth)
 *   - `analysis/` (derived JSON sidecars, including future orphans
 *     once the SQLite substrate becomes the new source of truth)
 *   - `cloud-conversations/`, `exports/`, the `.demo` sentinel
 *   - Future: `chat-arch.db`, `chat-arch.db-wal`, `chat-arch.db-shm`
 *     (Rev3-A SQLite substrate; A8 SDK writes here)
 *
 * The `.gitkeep` exception preserves the directory itself so the
 * empty-state path still works on fresh clones.
 */
export async function wipeAll(dir: string): Promise<{ removed: number }> {
  const entries = await readdir(dir, { withFileTypes: true });
  let removed = 0;
  await Promise.all(
    entries.map(async (e) => {
      if (e.name === '.gitkeep') return;
      await rm(join(dir, e.name), { recursive: true, force: true });
      removed += 1;
    }),
  );
  return { removed };
}

/**
 * Partial-source mode — filter the manifest, delete the transcript
 * files belonging to removed sessions, sweep the `analysis/`
 * directory (always — its contents are derived from the manifest
 * and any source removal invalidates them), and remove the
 * `cloud-conversations/` directory if cloud was selected.
 *
 * Returns per-source removal tallies so the UI can render "X sessions
 * removed from cli-direct".
 */
export async function wipeSources(
  dir: string,
  selected: Set<SourceName>,
): Promise<{ removed: number; bySources: Record<string, number> }> {
  const manifest = await readManifest(dir);
  const bySources: Record<string, number> = {};
  let fileRemovals = 0;

  if (manifest) {
    const kept: ManifestSession[] = [];
    const toDelete: ManifestSession[] = [];
    for (const s of manifest.sessions) {
      if (selected.has(s.source as SourceName)) {
        toDelete.push(s);
        bySources[s.source] = (bySources[s.source] ?? 0) + 1;
      } else {
        kept.push(s);
      }
    }

    // Unlink the transcript files belonging to removed sessions.
    await Promise.all(
      toDelete.map(async (s) => {
        if (!s.transcriptPath) return;
        // Guard: resolve against `dir` and reject any path that
        // escapes. Mirrors the path-traversal check in the exporter.
        const resolved = resolve(dir, s.transcriptPath);
        if (!resolved.startsWith(resolve(dir))) return;
        try {
          await rm(resolved, { force: true });
          fileRemovals += 1;
        } catch {
          /* best-effort — manifest rewrite is the source of truth */
        }
      }),
    );

    // Rewrite the manifest with the filtered session list and
    // recomputed counts. Touch `generatedAt` so cache-busts land.
    const counts: Record<string, number> = {
      cloud: 0,
      cowork: 0,
      'cli-direct': 0,
      'cli-desktop': 0,
    };
    for (const s of kept) counts[s.source] = (counts[s.source] ?? 0) + 1;
    const next: Manifest = {
      ...manifest,
      generatedAt: Date.now(),
      counts,
      sessions: kept,
    };
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify(next, null, 2) + '\n',
    );
  }

  // Cloud conversations live under a top-level folder — wipe the
  // whole folder when cloud is selected (in case the manifest
  // missed some orphaned JSONs).
  if (selected.has('cloud')) {
    try {
      await rm(join(dir, 'cloud-conversations'), {
        recursive: true,
        force: true,
      });
    } catch {
      /* ignore */
    }
    // Demo-data sentinel is paired with a demo-seeded manifest;
    // if cloud is being pruned, the sentinel no longer reflects
    // reality and should drop.
    try {
      await rm(join(dir, '.demo'), { force: true });
    } catch {
      /* ignore */
    }
  }

  // Always wipe derived analysis files — they are a function of the
  // manifest, and any source change invalidates them. This is the
  // Rev3-A.A9 orphan-sweep: when the SQLite substrate (Rev3-A.A8)
  // becomes the source of truth for kernel outputs, the JSON sidecars
  // under `analysis/` are orphan, and partial-source wipes continue
  // to remove them via this same rm-call.
  try {
    await rm(join(dir, 'analysis'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const removed =
    fileRemovals + Object.values(bySources).reduce((a, b) => a + b, 0);
  return { removed, bySources };
}
