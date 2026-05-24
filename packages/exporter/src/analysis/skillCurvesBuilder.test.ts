import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionManifest, Topic, UnifiedSessionEntry } from '@chat-arch/schema';
import { buildSkillCurvesFile, isoWeekLabel } from './skillCurvesBuilder.js';

describe('buildSkillCurvesFile', () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    `chat-arch-skillcurves-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function makeEntry(id: string, updatedAt: number): UnifiedSessionEntry {
    return {
      id,
      source: 'cli-direct',
      rawSessionId: id,
      startedAt: updatedAt,
      updatedAt,
      durationMs: 0,
      title: id,
      titleSource: 'first-prompt',
      preview: null,
      userTurns: 0,
      model: null,
      cwdKind: 'host',
      totalCostUsd: null,
    } as UnifiedSessionEntry;
  }

  async function writeTopics(outDir: string, topics: Topic[]): Promise<void> {
    await writeFile(
      path.join(outDir, 'analysis', 'topics.json'),
      JSON.stringify({ generatedAt: 0, topics }),
      'utf8',
    );
  }

  it('happy path: topic with 8+ weeks of asks produces a classified result', async () => {
    const outDir = path.join(tmpRoot, 'happy');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    // 10 sessions, one per week, each tagged to the same topic.
    // Ask counts are monotonically decreasing (5,5,4,4,3,3,2,2,1,1)
    // → Mann-Kendall should signal a decreasing trend.
    const sessions: UnifiedSessionEntry[] = [];
    const sessionIds: string[] = [];
    const weekMs = 7 * 86_400_000;
    const baseTime = new Date('2025-01-06T00:00:00Z').getTime(); // ISO week 2025-W02 start
    const askCounts = [5, 5, 4, 4, 3, 3, 2, 2, 1, 1];
    for (let w = 0; w < askCounts.length; w += 1) {
      const n = askCounts[w]!;
      for (let i = 0; i < n; i += 1) {
        const id = `s-w${w}-${i}`;
        const updatedAt = baseTime + w * weekMs + i * 1000;
        sessions.push(makeEntry(id, updatedAt));
        sessionIds.push(id);
      }
    }

    const topic: Topic = {
      id: 'topic_react',
      displayName: '~react + hooks',
      sessionIds,
      projectIds: [],
      firstSeenAt: new Date(baseTime).toISOString(),
      lastSeenAt: new Date(baseTime + 10 * weekMs).toISOString(),
    };
    await writeTopics(outDir, [topic]);

    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': sessions.length, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions,
    } as SessionManifest;

    const result = await buildSkillCurvesFile(manifest, { outDir, now: 1 });
    expect(result.hasTopicsSidecar).toBe(true);
    expect(result.topicsAnalyzed).toBe(1);
    expect(result.file.results).toHaveLength(1);
    const r = result.file.results[0]!;
    expect(r.topicId).toBe('topic_react');
    expect(['Learning', 'Steady', 'Stuck-dependent']).toContain(r.classification);
    expect(r.weeksPresent).toBe(10);
  });

  it('determinism: same input → same output (reuse equivalent)', async () => {
    const outDir = path.join(tmpRoot, 'det');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    const sessions: UnifiedSessionEntry[] = [];
    const sessionIds: string[] = [];
    const weekMs = 7 * 86_400_000;
    const baseTime = new Date('2025-01-06T00:00:00Z').getTime();
    for (let w = 0; w < 8; w += 1) {
      for (let i = 0; i < 2; i += 1) {
        const id = `s-${w}-${i}`;
        sessions.push(makeEntry(id, baseTime + w * weekMs + i * 1000));
        sessionIds.push(id);
      }
    }
    const topic: Topic = {
      id: 'topic_x',
      displayName: 'X',
      sessionIds,
      projectIds: [],
      firstSeenAt: '',
      lastSeenAt: '',
    };
    await writeTopics(outDir, [topic]);

    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': sessions.length, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions,
    } as SessionManifest;

    const a = await buildSkillCurvesFile(manifest, { outDir, now: 1 });
    const b = await buildSkillCurvesFile(manifest, { outDir, now: 2 });
    expect(b.file.results).toEqual(a.file.results);
  });

  it('missing-input-graceful: missing topics.json → empty results, no crash', async () => {
    const outDir = path.join(tmpRoot, 'no-topics');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 0, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions: [],
    } as SessionManifest;

    const result = await buildSkillCurvesFile(manifest, { outDir, now: 1 });
    expect(result.hasTopicsSidecar).toBe(false);
    expect(result.topicsAnalyzed).toBe(0);

    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'skill-curves.json'), 'utf8'),
    );
    expect(onDisk.results).toEqual([]);
  });

  it('isoWeekLabel: correctly formats known dates', () => {
    // 2025-01-06 (Monday) is in ISO week 2.
    expect(isoWeekLabel(new Date('2025-01-06T00:00:00Z'))).toBe('2025-W02');
    expect(isoWeekLabel(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
  });
});
