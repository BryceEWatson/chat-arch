import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildProjectIdentityPreview,
  loadProjectOverrides,
} from '../../src/analysis/projectIdentity.js';
import { logger } from '../../src/lib/logger.js';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';

let outDir: string;
const warnings: string[] = [];

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-pi-preview-'));
  await mkdir(path.join(outDir, 'analysis'), { recursive: true });
  warnings.length = 0;
  logger.setSink((line) => {
    warnings.push(line);
  });
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

// Minimal valid UnifiedSessionEntry — mirrors discoverProjects.test.ts `s()`.
function s(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 1714521600000,
    updatedAt: 1714521600000,
    durationMs: 0,
    title: 'Session ' + id,
    titleSource: 'fallback',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  };
}

function manifestOf(sessions: UnifiedSessionEntry[]): SessionManifest {
  return {
    schemaVersion: 4,
    generatedAt: 1714521600000,
    counts: { cloud: sessions.length, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
    sessions,
  };
}

const BASELINE_PROJECTS = {
  generatedAt: 0,
  projects: [
    { id: 'proj_outputs', displayName: 'outputs', sessionIds: ['r1', 'r2'] },
    { id: '__unassigned__', displayName: '[UNASSIGNED]', sessionIds: ['p1'] },
  ],
};

describe('buildProjectIdentityPreview', () => {
  beforeEach(async () => {
    await writeFile(
      path.join(outDir, 'analysis', 'projects.json'),
      JSON.stringify(BASELINE_PROJECTS, null, 2),
      'utf8',
    );
  });

  it('diffs the new cascade bucketing against the live projects.json without mutating it', async () => {
    // r1/r2 are now scheduled-task sessions (resolvedVia 'scheduled-task',
    // bucket proj_routine-daily-sync) — they MOVED out of proj_outputs.
    // p1 now carries an explicit project field → proj_chat-arch.
    const manifest = manifestOf([
      s('r1', {
        cwdKind: 'vm',
        cwd: '/sessions/x',
        scheduledTaskId: 'daily-sync',
        title: 'Mar 28 – Daily sync',
      }),
      s('r2', {
        cwdKind: 'vm',
        cwd: '/sessions/y',
        scheduledTaskId: 'daily-sync',
        title: 'Mar 29 – Daily sync',
      }),
      s('p1', { project: 'chat-arch', title: 'chat-arch work' }),
    ]);

    const preview = await buildProjectIdentityPreview({
      outDir,
      manifest,
      overrides: [],
      manifestMtimeMs: 12345,
      now: 1714600000000,
    });

    // (a) preview file written + round-trips.
    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'project-identity-preview.json'), 'utf8'),
    );
    expect(onDisk).toEqual(preview);

    // (b) proj_outputs vanished (no session resolves to it now).
    expect(preview.summary.vanishedProjectIds).toContain('proj_outputs');

    // (c) the routine bucket is a new project id.
    expect(preview.summary.newProjectIds).toContain('proj_routine-daily-sync');

    // (d) r1/r2 moved from proj_outputs to the routine bucket.
    expect(preview.summary.movedSessionCount).toBeGreaterThanOrEqual(1);

    // (e) both r1 + r2 resolved via scheduled-task.
    expect(preview.resolvedViaCounts['scheduled-task']).toBe(2);

    // (g) inputSnapshot.exporterVersion is a non-empty string.
    expect(typeof preview.inputSnapshot.exporterVersion).toBe('string');
    expect(preview.inputSnapshot.exporterVersion.length).toBeGreaterThan(0);
  });

  it('(f) does NOT modify the live analysis/projects.json (non-destructive guarantee)', async () => {
    const before = await readFile(path.join(outDir, 'analysis', 'projects.json'), 'utf8');
    const manifest = manifestOf([
      s('r1', { cwdKind: 'vm', cwd: '/sessions/x', scheduledTaskId: 'daily-sync', title: 'Mar 28 – Daily sync' }),
      s('r2', { cwdKind: 'vm', cwd: '/sessions/y', scheduledTaskId: 'daily-sync', title: 'Mar 29 – Daily sync' }),
      s('p1', { project: 'chat-arch' }),
    ]);
    await buildProjectIdentityPreview({
      outDir,
      manifest,
      overrides: [],
      manifestMtimeMs: null,
      now: 1714600000000,
    });
    const after = await readFile(path.join(outDir, 'analysis', 'projects.json'), 'utf8');
    expect(after).toBe(before);
    expect(JSON.parse(after)).toEqual(BASELINE_PROJECTS);
  });

  it('sets noBaseline=true when no projects.json exists', async () => {
    await rm(path.join(outDir, 'analysis', 'projects.json'), { force: true });
    const manifest = manifestOf([s('p1', { project: 'chat-arch' })]);
    const preview = await buildProjectIdentityPreview({
      outDir,
      manifest,
      overrides: [],
      manifestMtimeMs: null,
      now: 1714600000000,
    });
    expect(preview.noBaseline).toBe(true);
    // No baseline → no moved-session diff.
    expect(preview.summary.movedSessionCount).toBe(0);
  });
});

describe('loadProjectOverrides', () => {
  it('returns [] when the file is absent', async () => {
    const overrides = await loadProjectOverrides(outDir);
    expect(overrides).toEqual([]);
  });

  it('keeps the valid row and drops the malformed (no match) row', async () => {
    await writeFile(
      path.join(outDir, 'projectOverrides.json'),
      JSON.stringify([
        { projectId: 'x', match: { sessionIds: ['a'] } },
        { projectId: 'broken' }, // no match → dropped
      ]),
      'utf8',
    );
    const overrides = await loadProjectOverrides(outDir);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.projectId).toBe('x');
    expect(overrides[0]?.match.sessionIds).toEqual(['a']);
  });
});
