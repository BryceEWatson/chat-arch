// Tests for the data-dir wipe helpers. Covers the Rev3-A.A9
// orphan-sweep contract: both kitchen-sink and partial-source modes
// remove derived `analysis/` JSONs (Rev3-A.A8 SQLite SDK arrival
// makes those orphans; the wipe path stays the same).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wipeAll, wipeSources } from '../../src/lib/clearDataDir.js';

async function seedDir(dir: string): Promise<void> {
  // Mimic a populated chat-arch-data/ tree with manifest, analysis
  // sidecars, cloud-conversations, a .demo sentinel, and a future-
  // SQLite-DB sibling so the orphan-sweep assertions are concrete.
  await writeFile(join(dir, '.gitkeep'), '');
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 4,
      generatedAt: 1000,
      counts: { cloud: 1, cowork: 1, 'cli-direct': 1, 'cli-desktop': 0 },
      sessions: [
        { id: 's1', source: 'cloud' },
        { id: 's2', source: 'cowork' },
        { id: 's3', source: 'cli-direct' },
      ],
    }),
  );
  await mkdir(join(dir, 'analysis'), { recursive: true });
  await writeFile(join(dir, 'analysis', 'composite-outcomes.json'), '{}');
  await writeFile(join(dir, 'analysis', 'narratives.json'), '[]');
  await writeFile(join(dir, 'analysis', 'patterns.json'), '[]');
  await mkdir(join(dir, 'cloud-conversations'), { recursive: true });
  await writeFile(join(dir, 'cloud-conversations', 'c1.json'), '{}');
  await writeFile(join(dir, '.demo'), '');
  // Future SQLite substrate file — kitchen-sink mode must wipe it.
  await writeFile(join(dir, 'chat-arch.db'), 'binary');
  await writeFile(join(dir, 'chat-arch.db-wal'), 'binary');
}

describe('wipeAll (kitchen-sink mode)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chat-arch-clear-all-'));
    await seedDir(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes everything except .gitkeep', async () => {
    const result = await wipeAll(dir);

    // Counted at least the eight top-level entries we seeded (manifest,
    // analysis dir, cloud-conversations dir, .demo, .db, .db-wal).
    expect(result.removed).toBeGreaterThanOrEqual(6);

    expect(existsSync(join(dir, '.gitkeep'))).toBe(true);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
    expect(existsSync(join(dir, 'analysis'))).toBe(false);
    expect(existsSync(join(dir, 'cloud-conversations'))).toBe(false);
    expect(existsSync(join(dir, '.demo'))).toBe(false);
  });

  it('sweeps the SQLite substrate family — Rev3-A forward-compat', async () => {
    // The plan calls out `*.db`, `*.db-wal`, `*.db-shm` explicitly;
    // verify kitchen-sink picks them up via the .gitkeep-only filter.
    await wipeAll(dir);
    expect(existsSync(join(dir, 'chat-arch.db'))).toBe(false);
    expect(existsSync(join(dir, 'chat-arch.db-wal'))).toBe(false);
  });

  it('sweeps orphan analysis sidecars (Rev3-A.A9 orphan-sweep contract)', async () => {
    await wipeAll(dir);
    // The analysis subdir is gone entirely — composite-outcomes,
    // narratives, patterns all swept regardless of whether they
    // were live (manifest-derived JSON) or orphan (post-SQLite).
    expect(existsSync(join(dir, 'analysis'))).toBe(false);
  });
});

describe('wipeSources (partial-source mode)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chat-arch-clear-partial-'));
    await seedDir(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('filters manifest sessions by source and recomputes counts', async () => {
    const result = await wipeSources(dir, new Set(['cloud']));

    expect(result.bySources).toEqual({ cloud: 1 });

    const remaining = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8'),
    );
    expect(remaining.sessions).toHaveLength(2);
    expect(remaining.sessions.every((s: { source: string }) => s.source !== 'cloud')).toBe(true);
    expect(remaining.counts.cloud).toBe(0);
    expect(remaining.counts.cowork).toBe(1);
    expect(remaining.counts['cli-direct']).toBe(1);
  });

  it('always wipes the analysis/ subdirectory (orphan-sweep contract)', async () => {
    // Partial-source wipes — even when 'cloud' isn't selected — must
    // still drop the analysis dir because its contents are manifest-
    // derived and stale the moment any session disappears. This is
    // the load-bearing claim from clear.ts:188-198.
    expect(existsSync(join(dir, 'analysis'))).toBe(true);
    await wipeSources(dir, new Set(['cowork']));
    expect(existsSync(join(dir, 'analysis'))).toBe(false);
  });

  it('removes cloud-conversations/ + .demo only when cloud is in the selection', async () => {
    // First: partial wipe NOT including cloud — those two artifacts
    // survive because they're cloud-rooted.
    await wipeSources(dir, new Set(['cowork']));
    expect(existsSync(join(dir, 'cloud-conversations'))).toBe(true);
    expect(existsSync(join(dir, '.demo'))).toBe(true);
  });

  it('removes cloud-conversations/ + .demo when cloud IS in the selection', async () => {
    await wipeSources(dir, new Set(['cloud']));
    expect(existsSync(join(dir, 'cloud-conversations'))).toBe(false);
    expect(existsSync(join(dir, '.demo'))).toBe(false);
  });

  it('returns aggregate "removed" tally including transcript-file unlinks', async () => {
    // No transcriptPath in the seeded sessions, so removed === count
    // of manifest sessions in the selection.
    const result = await wipeSources(dir, new Set(['cloud', 'cowork']));
    expect(result.removed).toBe(2);
  });

  it('handles missing manifest gracefully (degraded state)', async () => {
    await rm(join(dir, 'manifest.json'));
    const result = await wipeSources(dir, new Set(['cloud']));
    // No sessions counted, but analysis/ + cloud-conversations are
    // still swept on the cloud-selection path.
    expect(result.removed).toBe(0);
    expect(existsSync(join(dir, 'analysis'))).toBe(false);
    expect(existsSync(join(dir, 'cloud-conversations'))).toBe(false);
  });
});
