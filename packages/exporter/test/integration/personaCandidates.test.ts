import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  PersonaBucket,
  Project,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import {
  buildPersonaCandidatesFile,
  PERSONA_HEURISTIC_VERSION,
} from '../../src/analysis/personaCandidates.js';
import { logger } from '../../src/lib/logger.js';

/**
 * Per-spec test plan: assert the 6 heuristic buckets fill correctly
 * from a synthetic transcript with known prompt shapes per bucket.
 *
 * Fixture is intentionally minimal — one project, one session, one
 * user turn per bucket-target. The matcher is permissive enough that
 * each crafted prompt fires on exactly the intended bucket (plus the
 * always-on voice bucket for very short / very long turns).
 */

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-personas-'));
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

function mkSession(
  id: string,
  transcriptPath: string,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cli-direct',
    rawSessionId: id,
    startedAt: 1,
    updatedAt: 1_700_000_000_000,
    durationMs: 0,
    title: `session ${id}`,
    titleSource: 'fallback',
    preview: null,
    userTurns: 1,
    model: null,
    modelsUsed: [],
    cwdKind: 'cli-direct',
    cwd: null,
    project: 'demo-project',
    totalCostUsd: null,
    tokenTotals: null,
    transcriptPath,
    ...overrides,
  } as unknown as UnifiedSessionEntry;
}

function mkProject(
  id: string,
  displayName: string,
  sessionIds: readonly string[],
): Project {
  return {
    id,
    displayName,
    discoveredAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
    sessionIds: [...sessionIds],
    narrativeIds: [],
    topicIds: [],
    sentiment: 'neutral',
    source: 'cli-cwd',
  };
}

/** Build a JSONL transcript with one user turn per line. */
function jsonlTranscript(turns: readonly string[]): string {
  return turns
    .map((t, idx) =>
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: t }],
        },
        turnIndex: idx,
      }),
    )
    .join('\n');
}

async function writeTranscript(
  rel: string,
  turns: readonly string[],
): Promise<string> {
  const abs = path.resolve(outDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, jsonlTranscript(turns), 'utf8');
  return rel;
}

describe('persona-candidates heuristic extractor', () => {
  it('fills all 6 buckets from synthetic prompts targeting each pattern family', async () => {
    const turns = [
      // role-expertise — first-person-role pattern
      "I'm a senior software engineer working on a side project",
      // role-expertise — years-experience pattern
      "I've been writing Go for ten years but this is my first time touching the React side of this repo",
      // preferences — i-prefer pattern
      'I prefer small focused PRs over bundled ones',
      // preferences — use-X-not-Y pattern
      'use ripgrep not grep when scanning the corpus',
      // working-rhythm — loop-iterate pattern
      'loop until all validated issues are resolved, like before',
      // working-rhythm — continue-dont-wait pattern
      'continue, don\'t wait',
      // frictions — doesnt-work pattern
      "the auto-brief doesn't render the shipped-this-week section",
      // frictions — broken-failing pattern
      'CI is broken — the build crashes on the dist/ rebuild step',
      // project-specific — project-name-mention (project = "demo-project")
      'why does demo-project keep regenerating the same sidecar twice on every scan',
      // voice — terse
      'continue',
      // voice — verbose (≥1200 chars)
      'x'.repeat(1200) + ' this is a long pasted block of context for the persona stage',
    ];
    const transcriptPath = await writeTranscript(
      'cli-direct/demo/s1.jsonl',
      turns,
    );
    const session = mkSession('s1', transcriptPath);
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions: [session],
      counts: { total: 1, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const project = mkProject('demo-project', 'demo-project', ['s1']);
    const sessionToProject = new Map<string, string>([['s1', 'demo-project']]);

    const r = await buildPersonaCandidatesFile(manifest, {
      outDir,
      now: 1_700_000_000_000,
      projects: [project],
      sessionToProject,
    });

    expect(r.file.version).toBe(1);
    expect(r.file.heuristicVersion).toBe(PERSONA_HEURISTIC_VERSION);
    expect(r.file.projects).toHaveLength(1);
    const p = r.file.projects[0]!;
    expect(p.projectId).toBe('demo-project');
    expect(p.sessionsSampled).toBe(1);
    expect(p.sessionsWithCandidates).toBe(1);

    const buckets = p.candidatesByBucket;
    const filled: PersonaBucket[] = [];
    for (const bucket of [
      'role-expertise',
      'preferences',
      'project-specific',
      'working-rhythm',
      'frictions',
      'voice',
    ] as const) {
      if (buckets[bucket].length > 0) filled.push(bucket);
    }
    // All 6 buckets should fire from the crafted fixture.
    expect(filled.sort()).toEqual(
      [
        'frictions',
        'preferences',
        'project-specific',
        'role-expertise',
        'voice',
        'working-rhythm',
      ].sort(),
    );
  });

  it('emits a zero-candidate row when a project has fewer transcripts than expected', async () => {
    const transcriptPath = await writeTranscript('cli-direct/empty/s1.jsonl', [
      'hello',
    ]);
    const session = mkSession('s1', transcriptPath);
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions: [session],
      counts: { total: 1, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('quiet', 'quiet', ['s1']);

    const r = await buildPersonaCandidatesFile(manifest, {
      outDir,
      now: 1_700_000_000_000,
      projects: [proj],
      sessionToProject: new Map([['s1', 'quiet']]),
    });

    const p = r.file.projects[0]!;
    // 'hello' is 5 chars → terse voice bucket fires. The other 5
    // buckets should remain empty.
    expect(p.candidatesByBucket['role-expertise']).toHaveLength(0);
    expect(p.candidatesByBucket.preferences).toHaveLength(0);
    expect(p.candidatesByBucket.frictions).toHaveLength(0);
    expect(p.candidatesByBucket['working-rhythm']).toHaveLength(0);
    expect(p.candidatesByBucket.voice.length).toBeGreaterThan(0);
  });

  it('respects sessionsTotal vs sessionsSampled (project with no sessions still gets a row)', async () => {
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions: [],
      counts: { total: 0, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('phantom', 'phantom', []);

    const r = await buildPersonaCandidatesFile(manifest, {
      outDir,
      now: 1_700_000_000_000,
      projects: [proj],
      sessionToProject: new Map(),
    });

    expect(r.file.projects).toHaveLength(1);
    const p = r.file.projects[0]!;
    expect(p.sessionsTotal).toBe(0);
    expect(p.sessionsSampled).toBe(0);
    expect(p.sessionsWithCandidates).toBe(0);
  });

  it('caps candidates per bucket at MAX_CANDIDATES_PER_BUCKET (40)', async () => {
    // Build a transcript with 50 "I prefer X" prompts so the
    // preferences bucket overflows the cap.
    const turns: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      turns.push(`I prefer approach number ${i} for handling edge cases`);
    }
    const transcriptPath = await writeTranscript(
      'cli-direct/dense/s1.jsonl',
      turns,
    );
    const session = mkSession('s1', transcriptPath);
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions: [session],
      counts: { total: 1, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('dense', 'dense', ['s1']);

    const r = await buildPersonaCandidatesFile(manifest, {
      outDir,
      now: 1_700_000_000_000,
      projects: [proj],
      sessionToProject: new Map([['s1', 'dense']]),
    });

    const p = r.file.projects[0]!;
    expect(p.candidatesByBucket.preferences.length).toBeLessThanOrEqual(40);
  });
});
