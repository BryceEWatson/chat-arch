import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readPrunedFromSessionsIndex,
  collectPrunedEntries,
} from '../../src/lib/sessionsIndex.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-sessions-index-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('readPrunedFromSessionsIndex', () => {
  it('returns [] for a missing index file', async () => {
    const res = await readPrunedFromSessionsIndex(
      path.join(tmp, 'nope.json'),
      'host',
      'cli-direct',
    );
    expect(res).toEqual([]);
  });

  it('returns [] for malformed JSON (logs a warn-once, does not throw)', async () => {
    const p = path.join(tmp, 'sessions-index.json');
    await writeFile(p, '{ not valid json', 'utf8');
    const res = await readPrunedFromSessionsIndex(p, 'host', 'cli-direct');
    expect(res).toEqual([]);
  });

  it('reconstructs entries whose fullPath transcript is missing on disk', async () => {
    const p = path.join(tmp, 'sessions-index.json');
    await writeFile(
      p,
      JSON.stringify({
        version: 1,
        entries: [
          {
            sessionId: 'pruned-uuid-1111',
            fullPath: path.join(tmp, 'does-not-exist-1.jsonl'),
            fileMtime: 1700000000000,
            firstPrompt: 'You are acting as a senior maintainer creating a public toolkit.',
            messageCount: 30,
            created: '2026-01-22T18:26:44.673Z',
            modified: '2026-01-23T01:10:23.841Z',
            gitBranch: 'main',
            projectPath: 'C:\\Users\\Bryce\\Projects\\bryce-labs-toolkit',
          },
        ],
      }),
      'utf8',
    );
    const res = await readPrunedFromSessionsIndex(p, 'host', 'cli-direct');
    expect(res).toHaveLength(1);
    const e = res[0]!;
    expect(e.id).toBe('pruned-uuid-1111');
    expect(e.source).toBe('cli-direct');
    expect(e.transcriptStatus).toBe('pruned');
    expect(e.title).toBe('You are acting as a senior maintainer creating a public toolkit.');
    expect(e.titleSource).toBe('first-prompt');
    expect(e.cwdKind).toBe('host');
    expect(e.cwd).toBe('C:\\Users\\Bryce\\Projects\\bryce-labs-toolkit');
    expect(e.project).toBe('bryce-labs-toolkit');
    // messageCount=30 → userTurns ~= ceil(30/2) = 15
    expect(e.userTurns).toBe(15);
    expect(e.startedAt).toBe(Date.parse('2026-01-22T18:26:44.673Z'));
    expect(e.updatedAt).toBe(Date.parse('2026-01-23T01:10:23.841Z'));
    expect(e.userTextSamples).toEqual([
      'You are acting as a senior maintainer creating a public toolkit.',
    ]);
    expect(e.transcriptPath).toBeUndefined();
    expect(e.tokenTotals).toBeUndefined();
    expect(e.subagentRollup).toBeUndefined();
  });

  it('skips entries whose fullPath transcript IS still on disk (avoid double-emit)', async () => {
    // Create an actual transcript file the index points to.
    const transcript = path.join(tmp, 'live.jsonl');
    await writeFile(transcript, '{"type":"user","message":{"content":"hi"}}\n', 'utf8');
    const p = path.join(tmp, 'sessions-index.json');
    await writeFile(
      p,
      JSON.stringify({
        version: 1,
        entries: [
          {
            sessionId: 'live-uuid',
            fullPath: transcript,
            firstPrompt: 'still on disk',
            messageCount: 4,
            created: '2026-04-01T00:00:00.000Z',
            modified: '2026-04-01T00:30:00.000Z',
            projectPath: 'C:\\proj',
          },
          {
            sessionId: 'pruned-uuid',
            fullPath: path.join(tmp, 'gone.jsonl'),
            firstPrompt: 'long since deleted',
            messageCount: 12,
            created: '2026-01-01T00:00:00.000Z',
            modified: '2026-01-01T01:00:00.000Z',
            projectPath: 'C:\\proj',
          },
        ],
      }),
      'utf8',
    );
    const res = await readPrunedFromSessionsIndex(p, 'host', 'cli-direct');
    // Only the pruned one is emitted; live is left to the transcript walker.
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe('pruned-uuid');
  });

  it('drops entries with unparseable created/modified timestamps', async () => {
    const p = path.join(tmp, 'sessions-index.json');
    await writeFile(
      p,
      JSON.stringify({
        version: 1,
        entries: [
          {
            sessionId: 'no-dates',
            fullPath: path.join(tmp, 'never.jsonl'),
            firstPrompt: 'has no created field',
            messageCount: 3,
            projectPath: 'C:\\proj',
          },
          {
            sessionId: 'bad-dates',
            fullPath: path.join(tmp, 'never2.jsonl'),
            firstPrompt: 'gibberish date',
            messageCount: 3,
            created: 'not-a-date',
            modified: 'also-bad',
            projectPath: 'C:\\proj',
          },
        ],
      }),
      'utf8',
    );
    const res = await readPrunedFromSessionsIndex(p, 'host', 'cli-direct');
    expect(res).toEqual([]);
  });

  it('falls back to UNTITLED_SESSION when firstPrompt is missing', async () => {
    const p = path.join(tmp, 'sessions-index.json');
    await writeFile(
      p,
      JSON.stringify({
        version: 1,
        entries: [
          {
            sessionId: 'titleless',
            fullPath: path.join(tmp, 'gone.jsonl'),
            messageCount: 2,
            created: '2026-01-01T00:00:00.000Z',
            modified: '2026-01-01T00:30:00.000Z',
            projectPath: 'C:\\proj',
          },
        ],
      }),
      'utf8',
    );
    const res = await readPrunedFromSessionsIndex(p, 'host', 'cli-direct');
    expect(res).toHaveLength(1);
    expect(res[0]!.title).toBe('Untitled session');
    expect(res[0]!.titleSource).toBe('fallback');
    expect(res[0]!.userTextSamples).toBeUndefined();
  });
});

describe('collectPrunedEntries', () => {
  it('walks every project dir and aggregates pruned entries', async () => {
    const projectsRoot = tmp;
    await mkdir(path.join(projectsRoot, 'proj-a'));
    await mkdir(path.join(projectsRoot, 'proj-b'));
    await writeFile(
      path.join(projectsRoot, 'proj-a', 'sessions-index.json'),
      JSON.stringify({
        entries: [
          {
            sessionId: 'pruned-a',
            fullPath: path.join(projectsRoot, 'proj-a', 'gone.jsonl'),
            firstPrompt: 'A',
            messageCount: 2,
            created: '2026-01-01T00:00:00.000Z',
            modified: '2026-01-01T00:30:00.000Z',
            projectPath: 'C:\\a',
          },
        ],
      }),
      'utf8',
    );
    await writeFile(
      path.join(projectsRoot, 'proj-b', 'sessions-index.json'),
      JSON.stringify({
        entries: [
          {
            sessionId: 'pruned-b',
            fullPath: path.join(projectsRoot, 'proj-b', 'gone.jsonl'),
            firstPrompt: 'B',
            messageCount: 4,
            created: '2026-02-01T00:00:00.000Z',
            modified: '2026-02-01T01:00:00.000Z',
            projectPath: 'C:\\b',
          },
        ],
      }),
      'utf8',
    );
    // proj-c has no index file — should be ignored silently.
    await mkdir(path.join(projectsRoot, 'proj-c'));

    const { readdir } = await import('node:fs/promises');
    const res = await collectPrunedEntries(projectsRoot, 'host', 'cli-direct', readdir);
    expect(res.map((e) => e.id).sort()).toEqual(['pruned-a', 'pruned-b']);
  });

  it('returns [] for a non-existent projects root', async () => {
    const { readdir } = await import('node:fs/promises');
    const res = await collectPrunedEntries(
      path.join(tmp, 'nope'),
      'host',
      'cli-direct',
      readdir,
    );
    expect(res).toEqual([]);
  });
});
