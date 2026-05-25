/**
 * Tests for `surprisesBuilder` — Wave 2 #1 delta surprises.
 *
 * Focuses on the archive read / write / prune lifecycle introduced for
 * delta-kind detection. The kernel itself is unit-tested in
 * `computeSurprises.test.ts`; here we exercise the I/O shell.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { THRESHOLDS } from '@chat-arch/analysis';
import type { SurprisesOutput } from '@chat-arch/analysis';
import {
  archiveAndPrune,
  loadMostRecentArchive,
} from './surprisesBuilder.js';

const tmpRoot = path.join(
  os.tmpdir(),
  `chat-arch-surprises-builder-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function mkOutput(stamp: number): SurprisesOutput {
  return {
    version: 1,
    generatedAt: stamp,
    surprises: [],
    thresholds: {
      streakMin: THRESHOLDS.surprises.streakMin,
      itsQValueMax: THRESHOLDS.surprises.itsQValueMax,
      itsDeltaMin: THRESHOLDS.surprises.itsDeltaMin,
      reflexiveDeltaMin: THRESHOLDS.surprises.reflexiveDeltaMin,
      reflexiveEValueMin: THRESHOLDS.surprises.reflexiveEValueMin,
      decisionGoodFollowupsMin: THRESHOLDS.surprises.decisionGoodFollowupsMin,
      debtSpinningTopK: THRESHOLDS.surprises.debtSpinningTopK,
      debtSpinningMinClusterSize:
        THRESHOLDS.surprises.debtSpinningMinClusterSize,
    },
  };
}

function dayMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

describe('surprisesBuilder — loadMostRecentArchive', () => {
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns null when archive directory does not exist', async () => {
    const analysisDir = path.join(tmpRoot, 'no-archive', 'analysis');
    await mkdir(analysisDir, { recursive: true });
    const prior = await loadMostRecentArchive(analysisDir);
    expect(prior).toBeNull();
  });

  it('returns null when archive directory is empty', async () => {
    const analysisDir = path.join(tmpRoot, 'empty-archive', 'analysis');
    await mkdir(path.join(analysisDir, 'archive'), { recursive: true });
    const prior = await loadMostRecentArchive(analysisDir);
    expect(prior).toBeNull();
  });

  it('loads the most recent dated file by filename (lexicographic = chronological)', async () => {
    const analysisDir = path.join(tmpRoot, 'three-files', 'analysis');
    const archive = path.join(analysisDir, 'archive');
    await mkdir(archive, { recursive: true });
    await writeFile(
      path.join(archive, 'surprises-2026-04-01.json'),
      JSON.stringify(mkOutput(1)),
    );
    await writeFile(
      path.join(archive, 'surprises-2026-04-15.json'),
      JSON.stringify(mkOutput(15)),
    );
    await writeFile(
      path.join(archive, 'surprises-2026-04-10.json'),
      JSON.stringify(mkOutput(10)),
    );
    const prior = await loadMostRecentArchive(analysisDir);
    expect(prior).not.toBeNull();
    expect(prior?.generatedAt).toBe(15);
  });

  it('excludes today\'s stamp from candidates', async () => {
    const analysisDir = path.join(tmpRoot, 'exclude-today', 'analysis');
    const archive = path.join(analysisDir, 'archive');
    await mkdir(archive, { recursive: true });
    await writeFile(
      path.join(archive, 'surprises-2026-05-01.json'),
      JSON.stringify(mkOutput(1)),
    );
    await writeFile(
      path.join(archive, 'surprises-2026-05-24.json'),
      JSON.stringify(mkOutput(24)),
    );
    const prior = await loadMostRecentArchive(analysisDir, {
      todayStamp: '2026-05-24',
    });
    expect(prior).not.toBeNull();
    expect(prior?.generatedAt).toBe(1);
  });

  it('returns null when only today\'s file exists', async () => {
    const analysisDir = path.join(tmpRoot, 'only-today', 'analysis');
    const archive = path.join(analysisDir, 'archive');
    await mkdir(archive, { recursive: true });
    await writeFile(
      path.join(archive, 'surprises-2026-05-24.json'),
      JSON.stringify(mkOutput(24)),
    );
    const prior = await loadMostRecentArchive(analysisDir, {
      todayStamp: '2026-05-24',
    });
    expect(prior).toBeNull();
  });

  it('ignores non-matching filenames in the archive directory', async () => {
    const analysisDir = path.join(tmpRoot, 'mixed-names', 'analysis');
    const archive = path.join(analysisDir, 'archive');
    await mkdir(archive, { recursive: true });
    await writeFile(path.join(archive, 'README.md'), 'noise');
    await writeFile(path.join(archive, 'surprises.json'), 'noise');
    await writeFile(
      path.join(archive, 'surprises-2026-05-01.json'),
      JSON.stringify(mkOutput(1)),
    );
    const prior = await loadMostRecentArchive(analysisDir);
    expect(prior).not.toBeNull();
    expect(prior?.generatedAt).toBe(1);
  });

  it('returns null when most recent file is unparseable JSON (fail-soft)', async () => {
    const analysisDir = path.join(tmpRoot, 'broken-json', 'analysis');
    const archive = path.join(analysisDir, 'archive');
    await mkdir(archive, { recursive: true });
    await writeFile(
      path.join(archive, 'surprises-2026-05-15.json'),
      '{not-json',
    );
    const prior = await loadMostRecentArchive(analysisDir);
    expect(prior).toBeNull();
  });
});

describe('surprisesBuilder — archiveAndPrune', () => {
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes today\'s file under archive/ with the YYYY-MM-DD stamp', async () => {
    const analysisDir = path.join(tmpRoot, 'write', 'analysis');
    await mkdir(analysisDir, { recursive: true });
    const now = Date.UTC(2026, 4, 24); // 2026-05-24
    await archiveAndPrune(analysisDir, mkOutput(now), {
      now,
      retentionDays: 30,
    });
    const entries = await readdir(path.join(analysisDir, 'archive'));
    expect(entries).toContain('surprises-2026-05-24.json');
    const raw = await readFile(
      path.join(analysisDir, 'archive', 'surprises-2026-05-24.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as SurprisesOutput;
    expect(parsed.generatedAt).toBe(now);
  });

  it('prunes files older than retentionDays (filename-based)', async () => {
    const analysisDir = path.join(tmpRoot, 'prune', 'analysis');
    const archive = path.join(analysisDir, 'archive');
    await mkdir(archive, { recursive: true });
    // Pre-seed with several files, half within retention, half outside.
    const now = Date.UTC(2026, 4, 24); // 2026-05-24
    const retentionDays = 30;
    await writeFile(
      path.join(archive, 'surprises-2026-03-01.json'),
      JSON.stringify(mkOutput(1)),
    );
    await writeFile(
      path.join(archive, 'surprises-2026-04-01.json'),
      JSON.stringify(mkOutput(2)),
    );
    await writeFile(
      path.join(archive, 'surprises-2026-04-25.json'),
      JSON.stringify(mkOutput(3)),
    );
    await writeFile(
      path.join(archive, 'surprises-2026-05-10.json'),
      JSON.stringify(mkOutput(4)),
    );
    await archiveAndPrune(analysisDir, mkOutput(now), {
      now,
      retentionDays,
    });
    const remaining = (await readdir(archive))
      .filter((n) => /^surprises-\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .sort();
    // Cutoff = today - 30 = 2026-04-24. Anything strictly older than
    // that is pruned (2026-03-01 + 2026-04-01). 2026-04-25 stays
    // because 2026-04-25 >= 2026-04-24.
    expect(remaining).toEqual([
      'surprises-2026-04-25.json',
      'surprises-2026-05-10.json',
      'surprises-2026-05-24.json',
    ]);
  });

  it('always retains today\'s freshly-written file (within retention by definition)', async () => {
    const analysisDir = path.join(tmpRoot, 'today-retained', 'analysis');
    await mkdir(analysisDir, { recursive: true });
    const now = Date.UTC(2026, 4, 24);
    await archiveAndPrune(analysisDir, mkOutput(now), {
      now,
      retentionDays: 0, // aggressive; today still survives
    });
    const entries = await readdir(path.join(analysisDir, 'archive'));
    expect(entries).toContain('surprises-2026-05-24.json');
  });

  it('creates archive/ directory when missing', async () => {
    const analysisDir = path.join(tmpRoot, 'mkdir', 'analysis');
    await mkdir(analysisDir, { recursive: true });
    const now = Date.UTC(2026, 4, 24);
    await archiveAndPrune(analysisDir, mkOutput(now), {
      now,
      retentionDays: 30,
    });
    const stat = await readdir(path.join(analysisDir, 'archive'));
    expect(stat.length).toBeGreaterThan(0);
  });

  it('next-day call loads yesterday\'s file as most-recent prior', async () => {
    // Full round-trip: archive day 1, then call loadMostRecentArchive
    // on day 2 and confirm we get the day-1 snapshot back.
    const analysisDir = path.join(tmpRoot, 'roundtrip', 'analysis');
    await mkdir(analysisDir, { recursive: true });
    const day1 = Date.UTC(2026, 4, 23);
    const day2 = Date.UTC(2026, 4, 24);
    await archiveAndPrune(analysisDir, mkOutput(day1), {
      now: day1,
      retentionDays: 30,
    });
    const prior = await loadMostRecentArchive(analysisDir, {
      todayStamp: '2026-05-24',
    });
    expect(prior).not.toBeNull();
    expect(prior?.generatedAt).toBe(day1);
    // Day-2 call also retains its own archive without disturbing day-1.
    await archiveAndPrune(analysisDir, mkOutput(day2), {
      now: day2,
      retentionDays: 30,
    });
    const entries = (await readdir(path.join(analysisDir, 'archive'))).sort();
    expect(entries).toContain('surprises-2026-05-23.json');
    expect(entries).toContain('surprises-2026-05-24.json');
  });

  // Sanity check that the retention math uses 24h * 60 * 60 * 1000 = dayMs.
  it('retention window is measured in 24h days, not calendar weeks', async () => {
    const analysisDir = path.join(tmpRoot, 'day-math', 'analysis');
    const archive = path.join(analysisDir, 'archive');
    await mkdir(archive, { recursive: true });
    const now = Date.UTC(2026, 4, 24);
    // 31 days ago → just outside a 30-day window
    const oldStamp = new Date(now - dayMs(31)).toISOString().slice(0, 10);
    await writeFile(
      path.join(archive, `surprises-${oldStamp}.json`),
      JSON.stringify(mkOutput(1)),
    );
    await archiveAndPrune(analysisDir, mkOutput(now), {
      now,
      retentionDays: 30,
    });
    const remaining = await readdir(archive);
    expect(remaining).not.toContain(`surprises-${oldStamp}.json`);
  });
});
