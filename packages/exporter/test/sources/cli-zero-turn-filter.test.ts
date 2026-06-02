import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runCliExport,
  streamAggregate,
  buildCliDirectEntry,
  isZeroTurnSidecar,
} from '../../src/sources/cli.js';
import { logger } from '../../src/lib/logger.js';
import type { UnifiedSessionEntry } from '@chat-arch/schema';

// ---------------------------------------------------------------------------
// isZeroTurnSidecar — unit truth table (Project Identity v2 parse-boundary)
// ---------------------------------------------------------------------------

describe('isZeroTurnSidecar (unit)', () => {
  it('phantom: 0 turns + no cwd + no project → true (DROPPED)', () => {
    expect(isZeroTurnSidecar({ userTurns: 0, cwd: undefined, project: undefined })).toBe(true);
  });

  it('0-turn but HAS cwd → false (PRESERVED — the 24 chat-arch-sessions invariant)', () => {
    // A naive "drop all 0-turn" would wrongly drop these.
    expect(isZeroTurnSidecar({ userTurns: 0, cwd: 'C:/x/chat-arch' })).toBe(false);
  });

  it('0-turn but HAS project → false (PRESERVED)', () => {
    expect(isZeroTurnSidecar({ userTurns: 0, project: 'chat-arch' })).toBe(false);
  });

  it('0-turn but assistantTurns > 0 → false', () => {
    expect(isZeroTurnSidecar({ userTurns: 0, assistantTurns: 2 })).toBe(false);
  });

  it('normal session (userTurns > 0) → false', () => {
    expect(isZeroTurnSidecar({ userTurns: 5 })).toBe(false);
  });

  it('empty-string cwd/project treated as absent → true', () => {
    expect(isZeroTurnSidecar({ userTurns: 0, cwd: '', project: '' })).toBe(true);
  });

  it('assistantTurns explicitly 0 counts as absent → true', () => {
    expect(
      isZeroTurnSidecar({ userTurns: 0, assistantTurns: 0, cwd: undefined, project: undefined }),
    ).toBe(true);
  });

  it('combined: 0 turns + assistantTurns undefined + empty cwd + undefined project → true', () => {
    expect(isZeroTurnSidecar({ userTurns: 0, cwd: '', project: undefined })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runCliExport — end-to-end parse-boundary filter (hermetic)
// ---------------------------------------------------------------------------

const PHANTOM_UUID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const NORMAL_UUID = 'bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb';

let outDir: string;
let projectsRoot: string;
// Empty hermetic primary root so the export never walks the developer's real
// `~/.claude/projects` corpus (the default `projectsRoot`).
let emptyPrimaryRoot: string;
const warnings: string[] = [];

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cli-ztf-out-'));
  projectsRoot = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cli-ztf-proj-'));
  emptyPrimaryRoot = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cli-ztf-primary-'));
  warnings.length = 0;
  logger.setSink((line) => {
    warnings.push(line);
  });
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
  await rm(projectsRoot, { recursive: true, force: true });
  await rm(emptyPrimaryRoot, { recursive: true, force: true });
});

async function writeTranscript(
  projectDir: string,
  uuid: string,
  lines: readonly object[],
): Promise<string> {
  const dir = path.join(projectsRoot, projectDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

describe('runCliExport — 0-turn-sidecar parse-boundary filter (integration)', () => {
  it('drops the phantom ai-title sidecar but keeps the normal session', async () => {
    // Phantom: a 1-line `ai-title` transcript, 0 turns, no cwd, no project.
    await writeTranscript('proj-phantom', PHANTOM_UUID, [
      { type: 'ai-title', aiTitle: 'near-duplicate or not', sessionId: PHANTOM_UUID },
    ]);
    // Normal: a real user line carrying a cwd.
    await writeTranscript('proj-normal', NORMAL_UUID, [
      {
        type: 'user',
        timestamp: '2026-04-15T10:00:00.000Z',
        cwd: 'C:\\Users\\example\\Projects\\chat-arch',
        message: { role: 'user', content: 'real prompt' },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-15T10:00:05.000Z',
        message: { role: 'assistant', model: 'claude-opus-4-7', content: [] },
      },
    ]);

    const result = await runCliExport({ outDir, projectsRoot: emptyPrimaryRoot, additionalProjectsRoots: [projectsRoot] });

    // (a) phantom uuid is NOT in result.entries.
    expect(result.entries.find((e) => e.id === PHANTOM_UUID)).toBeUndefined();
    // (b) at least one parser skip recorded.
    expect(result.parserSkips.count).toBeGreaterThanOrEqual(1);
    // (c) reason is the 0-turn-sidecar tag.
    expect(result.parserSkips.reason).toBe('0-turn-sidecar');
    // (d) normal session IS present.
    const normal = result.entries.find((e) => e.id === NORMAL_UUID);
    expect(normal).toBeDefined();
    expect(normal?.cwd).toBe('C:\\Users\\example\\Projects\\chat-arch');
  });

  it('focused check: phantom aggregate has 0 turns + undefined cwd and builds to a dropped entry', async () => {
    // Confirms the end-to-end filter is grounded in the streamAggregate +
    // buildCliDirectEntry pipeline the integration test exercises.
    const file = await writeTranscript('proj-phantom', PHANTOM_UUID, [
      { type: 'ai-title', aiTitle: 'near-duplicate or not', sessionId: PHANTOM_UUID },
    ]);
    const agg = await streamAggregate(file);
    expect(agg.userTurns).toBe(0);
    expect(agg.cwd).toBeUndefined();

    const entry = buildCliDirectEntry(agg, PHANTOM_UUID, undefined, 1_000);
    expect(isZeroTurnSidecar(entry)).toBe(true);
  });

  it('writes a cli-sessions.json that excludes the dropped phantom', async () => {
    await writeTranscript('proj-phantom', PHANTOM_UUID, [
      { type: 'ai-title', aiTitle: 'phantom', sessionId: PHANTOM_UUID },
    ]);
    await writeTranscript('proj-normal', NORMAL_UUID, [
      {
        type: 'user',
        timestamp: '2026-04-15T10:00:00.000Z',
        cwd: 'C:\\Users\\example\\Projects\\chat-arch',
        message: { role: 'user', content: 'real prompt' },
      },
    ]);
    await runCliExport({ outDir, projectsRoot: emptyPrimaryRoot, additionalProjectsRoots: [projectsRoot] });
    const envelope = JSON.parse(
      await readFile(path.join(outDir, 'cli-sessions.json'), 'utf8'),
    ) as { __exporterVersion: string; entries: UnifiedSessionEntry[] };
    expect(envelope.entries.map((e) => e.id)).not.toContain(PHANTOM_UUID);
    expect(envelope.entries.map((e) => e.id)).toContain(NORMAL_UUID);
  });
});
