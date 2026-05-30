import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CompositeOutcomesFile,
  DecisionsFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { buildDecisionsFile } from './decisionsBuilder.js';

/**
 * Three required cases per Stream G spec:
 *   - happy path: detects + writes decisions.json with classification=null
 *   - cache reuse: prior file with matching heuristicVersion is reused on
 *     a session whose updatedAt <= prior generatedAt
 *   - missing-input-graceful: missing transcript counted as missing, no
 *     crash, file still written
 */
describe('buildDecisionsFile', () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    `chat-arch-decisions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function makeEntry(overrides: Partial<UnifiedSessionEntry>): UnifiedSessionEntry {
    return {
      id: 'sess-a',
      source: 'cli-direct',
      rawSessionId: 'sess-a',
      startedAt: 0,
      updatedAt: 0,
      durationMs: 0,
      title: 'fixture',
      titleSource: 'first-prompt',
      preview: null,
      userTurns: 0,
      model: null,
      cwdKind: 'host',
      totalCostUsd: null,
      ...overrides,
    } as UnifiedSessionEntry;
  }

  it('happy path: surfaces explicit-marker decision with outcomeRef when composite present', async () => {
    const outDir = path.join(tmpRoot, 'happy');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

    const transcript = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: "Decision: let's ship the new parser." },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'Acknowledged.' },
      }),
    ].join('\n');
    const transcriptPath = path.join('transcripts', 'sess-dec.jsonl');
    await writeFile(path.join(outDir, transcriptPath), transcript, 'utf8');

    // Composite-outcomes sidecar so the join populates outcomeRef.
    const composite: CompositeOutcomesFile = {
      compositeVersion: 1,
      weightsVersion: 1,
      weights: {
        testPass: 0.3,
        testFail: -0.4,
        buildPass: 0.2,
        prLandMerged: 0.5,
        prLandClosedUnmerged: -0.3,
        reworkSameSession: -0.2,
        reworkContinuation: -0.25,
        affirmation: 0.1,
      },
      weightsHash: 'deadbeefdeadbeef',
      generatedAt: 0,
      outcomes: [
        {
          sessionId: 'sess-dec',
          source: 'cli-direct',
          testPass: true,
          buildPass: null,
          prLand: null,
          noRework: null,
          affirmation: null,
          score: 0.7,
          linearLogit: 0.8,
          binary: 'good',
          weightsHash: 'deadbeefdeadbeef',
        },
      ],
      scannedSessionIds: ['sess-dec'],
    };
    await writeFile(
      path.join(outDir, 'analysis', 'composite-outcomes.json'),
      JSON.stringify(composite),
      'utf8',
    );

    const entry = makeEntry({ id: 'sess-dec', transcriptPath });
    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 1, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions: [entry],
    } as SessionManifest;

    const result = await buildDecisionsFile(manifest, { outDir, now: 100 });

    expect(result.totalCandidates).toBeGreaterThan(0);
    expect(result.scannedSessions).toBe(1);
    expect(result.missingTranscripts).toBe(0);

    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'decisions.json'), 'utf8'),
    );
    expect(onDisk.decisions.length).toBeGreaterThan(0);
    const first = onDisk.decisions[0];
    expect(first.classification).toBeNull();
    expect(first.outcomeRef.sessionId).toBe('sess-dec');
    expect(first.outcomeRef.binaryClass).toBe('good');
  });

  it('cache reuse: second build with updatedAt <= prior generatedAt reuses', async () => {
    const outDir = path.join(tmpRoot, 'reuse');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

    const transcript = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: "We've decided to use ripgrep." },
      }),
    ].join('\n');
    const transcriptPath = path.join('transcripts', 'sess-r.jsonl');
    await writeFile(path.join(outDir, transcriptPath), transcript, 'utf8');

    const entry = makeEntry({
      id: 'sess-r',
      transcriptPath,
      updatedAt: 50,
    });
    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 1, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions: [entry],
    } as SessionManifest;

    const first = await buildDecisionsFile(manifest, { outDir, now: 100 });
    expect(first.scannedSessions).toBe(1);
    expect(first.reusedSessions).toBe(0);
    expect(first.totalCandidates).toBeGreaterThan(0);

    const second = await buildDecisionsFile(manifest, { outDir, now: 200 });
    expect(second.scannedSessions).toBe(0);
    expect(second.reusedSessions).toBe(1);
    expect(second.totalCandidates).toBe(first.totalCandidates);
  });

  it('cache reuse: preserves skill-written classification + trustCalibration', async () => {
    const outDir = path.join(tmpRoot, 'reuse-classified');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

    const transcript = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: "We've decided to use ripgrep." },
      }),
    ].join('\n');
    const transcriptPath = path.join('transcripts', 'sess-c.jsonl');
    await writeFile(path.join(outDir, transcriptPath), transcript, 'utf8');

    const entry = makeEntry({ id: 'sess-c', transcriptPath, updatedAt: 50 });
    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 1, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions: [entry],
    } as SessionManifest;

    // First build emits the candidate with classification: null.
    await buildDecisionsFile(manifest, { outDir, now: 100 });

    // Simulate the /mine-decisions skill merging its results in.
    const decPath = path.join(outDir, 'analysis', 'decisions.json');
    const file = JSON.parse(await readFile(decPath, 'utf8')) as DecisionsFile;
    const patched = {
      ...file,
      decisions: file.decisions.map((d, i) =>
        i === 0
          ? {
              ...d,
              classification: {
                kind: 'explicit-go-with',
                distilledDecision: 'use ripgrep',
                chosen: ['ripgrep'],
                rejected: ['grep'],
                rationale: 'faster on large trees',
                confidence: 0.9,
                actionable: true,
              },
              trustCalibration: { acceptedAssistant: true, landed: true },
            }
          : d,
      ),
    };
    await writeFile(decPath, JSON.stringify(patched), 'utf8');

    // Rescan (unchanged session → reuse path).
    const second = await buildDecisionsFile(manifest, { outDir, now: 200 });
    expect(second.reusedSessions).toBe(1);

    const after = JSON.parse(await readFile(decPath, 'utf8')) as DecisionsFile;
    const row = after.decisions[0];
    expect(row?.classification?.distilledDecision).toBe('use ripgrep');
    expect(row?.classification?.rationale).toBe('faster on large trees');
    expect(row?.trustCalibration).toEqual({ acceptedAssistant: true, landed: true });
  });

  it('automation-exclusion: automated session is excluded, interactive twin included', async () => {
    const outDir = path.join(tmpRoot, 'automation');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

    // A transcript with an explicit decision marker so a candidate is
    // detected for whichever sessions are scanned.
    const transcript = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: "Decision: let's ship the new parser." },
      }),
    ].join('\n');
    const transcriptPath = path.join('transcripts', 'sess-shared.jsonl');
    await writeFile(path.join(outDir, transcriptPath), transcript, 'utf8');

    // Interactive + automated twin pointing at the SAME transcript — the
    // only difference is `automationTemplateId`.
    const interactive = makeEntry({ id: 'sess-int', transcriptPath });
    const automated = makeEntry({
      id: 'sess-auto',
      transcriptPath,
      automationTemplateId: 'status-paragraph',
    });
    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 2, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions: [interactive, automated],
    } as SessionManifest;

    const result = await buildDecisionsFile(manifest, { outDir, now: 100 });
    // Only the interactive session is scanned; the automated one is dropped.
    expect(result.scannedSessions).toBe(1);
    expect(result.missingTranscripts).toBe(0);

    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'decisions.json'), 'utf8'),
    ) as DecisionsFile;
    expect(onDisk.scannedSessionIds).toContain('sess-int');
    expect(onDisk.scannedSessionIds).not.toContain('sess-auto');
    for (const d of onDisk.decisions) {
      expect(d.candidate.sessionId).not.toBe('sess-auto');
    }
  });

  it('missing-input-graceful: counts missing transcripts, still writes file', async () => {
    const outDir = path.join(tmpRoot, 'missing');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    // No transcript file on disk — readTurnPairs returns null → missing.
    const entry = makeEntry({
      id: 'sess-m',
      transcriptPath: 'transcripts/does-not-exist.jsonl',
    });
    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 1, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions: [entry],
    } as SessionManifest;

    const result = await buildDecisionsFile(manifest, { outDir, now: 1 });
    expect(result.missingTranscripts).toBe(1);
    expect(result.scannedSessions).toBe(0);
    expect(result.totalCandidates).toBe(0);

    // File on disk exists with the expected shape, even if empty.
    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'decisions.json'), 'utf8'),
    );
    expect(onDisk.decisions).toEqual([]);
    expect(onDisk.scannedSessionIds).toEqual([]);
    expect(typeof onDisk.decisionHeuristicVersion).toBe('number');
  });
});
