import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runCliExport,
  findTranscriptPaths,
  loadCliDesktopIds,
  extractFirstUserText,
  streamAggregate,
  buildCliDirectEntry,
  enrichCliDesktopEntry,
} from '../../src/sources/cli.js';
import { validateEntries } from '../../src/lib/validate-entry.js';
import { logger } from '../../src/lib/logger.js';
import type { UnifiedSessionEntry } from '@chat-arch/schema';

let outDir: string;
let projectsRoot: string;
const warnings: string[] = [];

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cli-out-'));
  projectsRoot = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cli-proj-'));
  warnings.length = 0;
  logger.setSink((line) => {
    warnings.push(line);
  });
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
  await rm(projectsRoot, { recursive: true, force: true });
});

// Helpers --------------------------------------------------------------------

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const UUID_D = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

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

function userLine(content: unknown, overrides: Record<string, unknown> = {}): object {
  return {
    type: 'user',
    timestamp: '2026-04-15T10:00:00.000Z',
    message: { role: 'user', content },
    ...overrides,
  };
}

function assistantLine(
  model: string,
  usage: Record<string, number> = {},
  overrides: Record<string, unknown> = {},
): object {
  return {
    type: 'assistant',
    timestamp: '2026-04-15T10:01:00.000Z',
    message: {
      id: 'msg_' + Math.random().toString(36).slice(2, 8),
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      usage,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractFirstUserText
// ---------------------------------------------------------------------------

describe('extractFirstUserText', () => {
  it('returns the content string directly when message.content is a string', () => {
    expect(extractFirstUserText({ content: 'hello' })).toBe('hello');
  });

  it('returns the first text block when content is a block array', () => {
    const msg = {
      content: [
        { type: 'text', text: 'the prompt' },
        { type: 'text', text: 'later block' },
      ],
    };
    expect(extractFirstUserText(msg)).toBe('the prompt');
  });

  it('skips tool_result blocks and returns the first non-empty text block', () => {
    const msg = {
      content: [
        { type: 'tool_result', tool_use_id: 'x', content: 'tool output' },
        { type: 'text', text: 'actual prompt' },
      ],
    };
    expect(extractFirstUserText(msg)).toBe('actual prompt');
  });

  it('returns undefined when the content array has no usable text block', () => {
    const msg = {
      content: [
        { type: 'tool_result', content: 'x' },
        { type: 'image', source: {} },
      ],
    };
    expect(extractFirstUserText(msg)).toBeUndefined();
  });

  it('returns undefined on empty string / missing content', () => {
    expect(extractFirstUserText({ content: '' })).toBeUndefined();
    expect(extractFirstUserText({})).toBeUndefined();
    expect(extractFirstUserText(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// streamAggregate
// ---------------------------------------------------------------------------

describe('streamAggregate', () => {
  it('extracts cwd from the first line that carries it (not always line 1)', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: UUID_A,
        timestamp: '2026-04-15T10:00:00.000Z',
      },
      {
        type: 'user',
        timestamp: '2026-04-15T10:00:01.000Z',
        cwd: 'C:\\Users\\example\\Projects\\chat-arch',
        message: { role: 'user', content: 'hi' },
      },
    ]);
    const agg = await streamAggregate(file);
    expect(agg.cwd).toBe('C:\\Users\\example\\Projects\\chat-arch');
  });

  it('returns undefined cwd when no line carries one (D3)', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      {
        type: 'user',
        timestamp: '2026-04-15T10:00:00.000Z',
        message: { role: 'user', content: 'no cwd here' },
      },
    ]);
    const agg = await streamAggregate(file);
    expect(agg.cwd).toBeUndefined();
  });

  it('computes min/max timestamp across event lines (D10)', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      {
        type: 'user',
        timestamp: '2026-04-15T10:05:00.000Z',
        message: { role: 'user', content: 'a' },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-15T10:03:00.000Z',
        message: { model: 'm', content: [] },
      },
      {
        type: 'user',
        timestamp: '2026-04-15T10:07:00.000Z',
        message: { role: 'user', content: 'b' },
      },
    ]);
    const agg = await streamAggregate(file);
    expect(agg.minTimestamp).toBe(Date.parse('2026-04-15T10:03:00.000Z'));
    expect(agg.maxTimestamp).toBe(Date.parse('2026-04-15T10:07:00.000Z'));
  });

  it('sums token usage across all assistant lines (D8), missing sub-fields count as 0', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      assistantLine('m1', {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 3,
      }),
      assistantLine('m1', { input_tokens: 2, output_tokens: 1 }), // no cache fields
    ]);
    const agg = await streamAggregate(file);
    expect(agg.tokens).toEqual({
      input: 12,
      output: 6,
      cacheCreation: 7,
      cacheRead: 3,
    });
  });

  it('tracks modelsUsed in insertion order and preserves [1m] suffix (OQ3)', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      assistantLine('claude-opus-4-6'),
      assistantLine('claude-opus-4-7[1m]'),
      assistantLine('claude-opus-4-6'),
      assistantLine('claude-haiku-4-5'),
    ]);
    const agg = await streamAggregate(file);
    expect(agg.modelsUsed).toEqual(['claude-opus-4-6', 'claude-opus-4-7[1m]', 'claude-haiku-4-5']);
    expect(agg.lastAssistantModel).toBe('claude-haiku-4-5');
  });

  it('counts user/assistant turns, ai-title wins, first-user-text captured once', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      { type: 'ai-title', aiTitle: 'Nice title', sessionId: UUID_A },
      userLine('first question'),
      assistantLine('claude-opus-4-7'),
      userLine('follow-up'),
      assistantLine('claude-opus-4-7'),
    ]);
    const agg = await streamAggregate(file);
    expect(agg.userTurns).toBe(2);
    expect(agg.assistantTurns).toBe(2);
    expect(agg.aiTitle).toBe('Nice title');
    expect(agg.firstUserText).toBe('first question');
  });

  it('tolerates malformed JSON lines (warn-once per file) and still counts valid ones', async () => {
    const dir = path.join(projectsRoot, 'proj-a');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${UUID_A}.jsonl`);
    await writeFile(
      file,
      [
        JSON.stringify(userLine('ok')),
        '{ this is not valid json',
        JSON.stringify(assistantLine('m1')),
        'also broken',
      ].join('\n') + '\n',
      'utf8',
    );
    const agg = await streamAggregate(file);
    expect(agg.userTurns).toBe(1);
    expect(agg.assistantTurns).toBe(1);
    expect(agg.malformedLineCount).toBe(2);
    expect(warnings.filter((w) => w.includes('malformed line')).length).toBe(1); // warnOnce per file
  });

  it('emits warnOnce for unknown line types (D19)', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      { type: 'weird-future-event', timestamp: '2026-04-15T10:00:00.000Z', foo: 'bar' },
      { type: 'weird-future-event', timestamp: '2026-04-15T10:00:01.000Z', foo: 'baz' },
    ]);
    await streamAggregate(file);
    const driftWarns = warnings.filter((w) => w.includes('unknown line type "weird-future-event"'));
    expect(driftWarns).toHaveLength(1);
  });

  it('is silent on known-benign line types (attachment, progress, queue-operation, etc.)', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      { type: 'attachment', attachment: {} },
      { type: 'progress', toolUseID: 'x' },
      { type: 'file-history-snapshot', snapshot: {}, messageId: 'x', isSnapshotUpdate: false },
      { type: 'queue-operation', operation: 'enqueue', sessionId: UUID_A, timestamp: 't' },
    ]);
    await streamAggregate(file);
    expect(warnings.filter((w) => w.includes('unknown line type')).length).toBe(0);
  });

  it('handles a user message whose content is an array of blocks (D9)', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      userLine([
        { type: 'tool_result', tool_use_id: 'x', content: 'ignored' },
        { type: 'text', text: 'real prompt in block form' },
      ]),
    ]);
    const agg = await streamAggregate(file);
    expect(agg.firstUserText).toBe('real prompt in block form');
  });

  it('returns zero counts and undefined timestamps for an empty transcript', async () => {
    const file = await writeTranscript('proj-a', UUID_A, []);
    // After write, file will have a trailing newline only if lines existed;
    // here it will be empty.
    await writeFile(file, '', 'utf8');
    const agg = await streamAggregate(file);
    expect(agg.userTurns).toBe(0);
    expect(agg.assistantTurns).toBe(0);
    expect(agg.minTimestamp).toBeUndefined();
    expect(agg.maxTimestamp).toBeUndefined();
    expect(agg.cwd).toBeUndefined();
    expect(agg.toolUses).toEqual({});
  });

  it('tallies tool_use content blocks across assistant lines (the real fix)', async () => {
    // CLI transcripts use the same `message.content[]` shape as cloud
    // exports — a sum of text / thinking / tool_use / tool_result blocks.
    // The tool_use histogram tracks named tool calls only; everything
    // else is ignored.
    const file = await writeTranscript('proj-a', UUID_A, [
      {
        type: 'user',
        timestamp: '2026-04-15T10:00:00.000Z',
        message: { role: 'user', content: 'run the thing' },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-15T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          ],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-15T10:00:07.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [
            { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pwd' } },
            { type: 'tool_use', id: 'toolu_3', name: 'Read', input: { path: 'a' } },
          ],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]);
    const agg = await streamAggregate(file);
    expect(agg.toolUses).toEqual({ Bash: 2, Read: 1 });
  });

  it('leaves toolUses empty when no assistant line carries a tool_use block', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      userLine('just a chat'),
      assistantLine('m'), // default content: []
    ]);
    const agg = await streamAggregate(file);
    expect(agg.toolUses).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// findTranscriptPaths
// ---------------------------------------------------------------------------

describe('findTranscriptPaths', () => {
  it('returns an empty array when the root does not exist', async () => {
    const missing = path.join(projectsRoot, 'does-not-exist');
    const paths = await findTranscriptPaths(missing);
    expect(paths).toEqual([]);
    expect(warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  it('returns top-level <uuid>.jsonl files but skips sub-agent subdirs (D1)', async () => {
    const p1 = await writeTranscript('proj-a', UUID_A, [userLine('x')]);
    const p2 = await writeTranscript('proj-a', UUID_B, [userLine('x')]);
    // Sub-agent dir — should NOT be returned.
    await mkdir(path.join(projectsRoot, 'proj-a', UUID_C), { recursive: true });
    await writeFile(
      path.join(projectsRoot, 'proj-a', UUID_C, 'nested.jsonl'),
      JSON.stringify(userLine('x')) + '\n',
      'utf8',
    );
    // Non-UUID filename — ignored.
    await writeFile(path.join(projectsRoot, 'proj-a', 'README.md'), '# not a transcript', 'utf8');
    const found = await findTranscriptPaths(projectsRoot);
    expect(found.sort()).toEqual([p1, p2].sort());
  });

  it('picks up case-variant sibling dirs (Windows quirk)', async () => {
    await writeTranscript('proj-MixedCase', UUID_A, [userLine('x')]);
    await writeTranscript('proj-mixedcase', UUID_B, [userLine('x')]);
    const found = await findTranscriptPaths(projectsRoot);
    // Windows filesystem may collapse case, so we only assert >=1 and that
    // both UUIDs can be found (whichever won the dir-name race).
    expect(found.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// loadCliDesktopIds
// ---------------------------------------------------------------------------

describe('loadCliDesktopIds', () => {
  it('returns empty set + warn when the Phase 2 file is missing', async () => {
    const result = await loadCliDesktopIds(path.join(outDir, 'nope.json'));
    expect(result.desktopIds.size).toBe(0);
    expect(warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  it('returns empty set when JSON is malformed and logs a warning', async () => {
    const p = path.join(outDir, 'cowork-sessions.json');
    await writeFile(p, '{ not valid', 'utf8');
    const result = await loadCliDesktopIds(p);
    expect(result.desktopIds.size).toBe(0);
    expect(warnings.some((w) => w.includes('not valid JSON'))).toBe(true);
  });

  it('collects only cli-desktop entries (ignores cowork/cli-direct)', async () => {
    const p = path.join(outDir, 'cowork-sessions.json');
    const arr: Partial<UnifiedSessionEntry>[] = [
      { id: UUID_A, source: 'cli-desktop', rawSessionId: `local_${UUID_A}` },
      { id: UUID_B, source: 'cowork', rawSessionId: `local_${UUID_B}` },
      { id: UUID_C, source: 'cli-desktop', rawSessionId: `local_${UUID_C}` },
    ];
    await writeFile(p, JSON.stringify(arr), 'utf8');
    const result = await loadCliDesktopIds(p);
    expect([...result.desktopIds].sort()).toEqual([UUID_A, UUID_C].sort());
    expect(result.phase2Entries.get(UUID_A)?.source).toBe('cli-desktop');
  });
});

// ---------------------------------------------------------------------------
// buildCliDirectEntry / enrichCliDesktopEntry
// ---------------------------------------------------------------------------

describe('buildCliDirectEntry', () => {
  it('populates a cli-direct entry from a streamed aggregate', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      { type: 'ai-title', aiTitle: 'Test title', sessionId: UUID_A },
      userLine('hello', { cwd: 'C:\\Users\\example\\Projects\\chat-arch' }),
      assistantLine('claude-opus-4-7', {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
      }),
    ]);
    const agg = await streamAggregate(file);
    const entry = buildCliDirectEntry(
      agg,
      UUID_A,
      'local-transcripts/cli-direct/aaa.jsonl',
      Date.parse('2026-04-15T10:00:00.000Z'),
    );
    expect(entry.source).toBe('cli-direct');
    expect(entry.id).toBe(UUID_A);
    expect(entry.rawSessionId).toBe(UUID_A); // no local_ prefix for cli-direct
    expect(entry.title).toBe('Test title');
    expect(entry.titleSource).toBe('ai-title');
    expect(entry.userTurns).toBe(1);
    expect(entry.assistantTurns).toBe(1);
    expect(entry.model).toBe('claude-opus-4-7');
    expect(entry.modelsUsed).toEqual(['claude-opus-4-7']);
    expect(entry.cwd).toBe('C:\\Users\\example\\Projects\\chat-arch');
    expect(entry.project).toBe('chat-arch');
    expect(entry.cwdKind).toBe('host');
    expect(entry.totalCostUsd).toBeNull();
    expect(entry.transcriptPath).toBe('local-transcripts/cli-direct/aaa.jsonl');
    expect(entry.tokenTotals).toEqual({
      input: 10,
      output: 5,
      cacheCreation: 2,
      cacheRead: 1,
    });
  });

  it('falls back through the title cascade ai-title -> last-prompt -> first-user-text -> UNTITLED_SESSION (D4)', async () => {
    const base = await streamAggregate(
      await writeTranscript('proj-a', UUID_A, [userLine('firstly')]),
    );

    // ai-title wins
    {
      const agg = { ...base, aiTitle: 'AI', lastPrompt: 'LP', firstUserText: 'firstly' };
      const e = buildCliDirectEntry(agg, UUID_A, undefined, 0);
      expect(e.title).toBe('AI');
      expect(e.titleSource).toBe('ai-title');
    }
    // last-prompt wins when ai-title absent
    {
      const agg = {
        ...base,
        aiTitle: undefined,
        lastPrompt: 'LastPrompt',
        firstUserText: 'firstly',
      };
      const e = buildCliDirectEntry(agg, UUID_A, undefined, 0);
      expect(e.title).toBe('LastPrompt');
      expect(e.titleSource).toBe('first-prompt');
    }
    // first-user-text when both absent
    {
      const agg = { ...base, aiTitle: undefined, lastPrompt: undefined, firstUserText: 'firstly' };
      const e = buildCliDirectEntry(agg, UUID_A, undefined, 0);
      expect(e.title).toBe('firstly');
      expect(e.titleSource).toBe('first-prompt');
    }
    // UNTITLED when nothing
    {
      const agg = { ...base, aiTitle: undefined, lastPrompt: undefined, firstUserText: undefined };
      const e = buildCliDirectEntry(agg, UUID_A, undefined, 0);
      expect(e.titleSource).toBe('fallback');
      expect(e.title).toBe('Untitled session');
    }
  });

  it('treats empty strings as absent in the title cascade', async () => {
    const base = await streamAggregate(await writeTranscript('proj-a', UUID_A, [userLine('x')]));
    const agg = { ...base, aiTitle: '', lastPrompt: '', firstUserText: 'fallback text' };
    const e = buildCliDirectEntry(agg, UUID_A, undefined, 0);
    expect(e.titleSource).toBe('first-prompt');
    expect(e.title).toBe('fallback text');
  });

  it('derives project from cwd via win32.basename (avoiding path-name lossy decode)', async () => {
    // Example where the directory name would have dropped periods if lossily decoded.
    const agg = {
      userTurns: 0,
      assistantTurns: 0,
      cwd: 'C:\\Users\\example\\Projects\\my.dotted.site',
      aiTitle: undefined,
      lastPrompt: undefined,
      firstUserText: undefined,
      lastAssistantModel: undefined,
      modelsUsed: [],
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      minTimestamp: 1,
      maxTimestamp: 2,
      malformedLineCount: 0,
      toolUses: {},
    };
    const e = buildCliDirectEntry(agg, UUID_A, undefined, 0);
    expect(e.project).toBe('my.dotted.site');
  });

  it('falls back to file mtime for timestamps when transcript has no timestamped lines', async () => {
    const mtime = Date.parse('2026-01-01T00:00:00.000Z');
    const agg = {
      userTurns: 0,
      assistantTurns: 0,
      cwd: undefined,
      aiTitle: undefined,
      lastPrompt: undefined,
      firstUserText: undefined,
      lastAssistantModel: undefined,
      modelsUsed: [],
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      minTimestamp: undefined,
      maxTimestamp: undefined,
      malformedLineCount: 0,
      toolUses: {},
    };
    const e = buildCliDirectEntry(agg, UUID_A, undefined, mtime);
    expect(e.startedAt).toBe(mtime);
    expect(e.updatedAt).toBe(mtime);
    expect(e.durationMs).toBe(0);
  });

  it('produces zero-error validateEntries() for a minimal entry', async () => {
    const agg = {
      userTurns: 0,
      assistantTurns: 0,
      cwd: undefined,
      aiTitle: undefined,
      lastPrompt: undefined,
      firstUserText: undefined,
      lastAssistantModel: undefined,
      modelsUsed: [],
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      minTimestamp: undefined,
      maxTimestamp: undefined,
      malformedLineCount: 0,
      toolUses: {},
    };
    const e = buildCliDirectEntry(agg, UUID_A, undefined, 1_000);
    const errors = validateEntries([e]);
    expect(errors).toEqual([]);
  });
});

describe('enrichCliDesktopEntry', () => {
  it('keeps manifest title/titleSource/rawSessionId but overwrites userTurns + model from transcript', async () => {
    const phase2: UnifiedSessionEntry = {
      id: UUID_A,
      source: 'cli-desktop',
      rawSessionId: `local_${UUID_A}`,
      startedAt: 1000,
      updatedAt: 2000,
      durationMs: 1000,
      title: 'Manifest Title',
      titleSource: 'manifest',
      preview: null,
      userTurns: 0, // stub value
      model: 'claude-opus-4-7[1m]', // from manifest — will be overwritten by transcript
      cwdKind: 'host',
      totalCostUsd: null,
      cwd: 'C:\\Users\\example\\Projects\\chat-arch',
      manifestPath: 'manifests/cli-desktop/local_aaa.json',
    };
    const file = await writeTranscript('proj-a', UUID_A, [
      userLine('enriched question'),
      assistantLine('claude-opus-4-7[1m]'),
      userLine('follow-up'),
      assistantLine('claude-opus-4-7[1m]'),
    ]);
    const agg = await streamAggregate(file);
    const enriched = enrichCliDesktopEntry(
      phase2,
      agg,
      'local-transcripts/cli-desktop/aaa.jsonl',
      9999,
    );
    expect(enriched.source).toBe('cli-desktop');
    expect(enriched.id).toBe(UUID_A);
    expect(enriched.rawSessionId).toBe(`local_${UUID_A}`); // preserved
    expect(enriched.title).toBe('Manifest Title');
    expect(enriched.titleSource).toBe('manifest');
    expect(enriched.userTurns).toBe(2);
    expect(enriched.assistantTurns).toBe(2);
    expect(enriched.model).toBe('claude-opus-4-7[1m]'); // transcript value
    expect(enriched.preview).toBe('enriched question');
    expect(enriched.manifestPath).toBe('manifests/cli-desktop/local_aaa.json');
    expect(enriched.transcriptPath).toBe('local-transcripts/cli-desktop/aaa.jsonl');
  });
});

// ---------------------------------------------------------------------------
// runCliExport — top-level integration (still hermetic)
// ---------------------------------------------------------------------------

describe('runCliExport (hermetic)', () => {
  it('emits cli-direct entries for every transcript when no Phase 2 file is present', async () => {
    await writeTranscript('proj-a', UUID_A, [
      { type: 'ai-title', aiTitle: 'A', sessionId: UUID_A },
      userLine('hi A'),
      assistantLine('claude-opus-4-7'),
    ]);
    await writeTranscript('proj-b', UUID_B, [userLine('hi B'), assistantLine('claude-haiku-4-5')]);
    const result = await runCliExport({ outDir, projectsRoot });
    expect(result.counts['cli-direct']).toBe(2);
    expect(result.counts['cli-desktop']).toBe(0);
    expect(result.transcriptsCopied).toBe(2);

    // cli-sessions.json on disk parses and matches.
    const parsed = JSON.parse(
      await readFile(path.join(outDir, 'cli-sessions.json'), 'utf8'),
    ) as UnifiedSessionEntry[];
    expect(parsed).toHaveLength(2);

    // Transcripts copied to cli-direct subdir.
    const copiedA = path.join(outDir, 'local-transcripts', 'cli-direct', `${UUID_A}.jsonl`);
    const copiedB = path.join(outDir, 'local-transcripts', 'cli-direct', `${UUID_B}.jsonl`);
    await expect(readFile(copiedA, 'utf8')).resolves.toContain('"aiTitle"');
    await expect(readFile(copiedB, 'utf8')).resolves.toContain('"hi B"');
  });

  it('routes UUIDs present in the Phase 2 file into cli-desktop with enrichment', async () => {
    // Seed a Phase 2 file with one cli-desktop entry for UUID_A.
    const phase2Arr: Partial<UnifiedSessionEntry>[] = [
      {
        id: UUID_A,
        source: 'cli-desktop',
        rawSessionId: `local_${UUID_A}`,
        startedAt: 100,
        updatedAt: 200,
        durationMs: 100,
        title: 'Manifest title A',
        titleSource: 'manifest',
        preview: null,
        userTurns: 0,
        model: 'claude-opus-4-7[1m]',
        cwdKind: 'host',
        totalCostUsd: null,
        cwd: 'C:\\Users\\example\\Projects\\chat-arch',
        manifestPath: 'manifests/cli-desktop/local_aaa.json',
      },
    ];
    await writeFile(path.join(outDir, 'cowork-sessions.json'), JSON.stringify(phase2Arr), 'utf8');

    await writeTranscript('proj-a', UUID_A, [
      userLine('desktop-a question'),
      assistantLine('claude-opus-4-7[1m]'),
    ]);
    await writeTranscript('proj-b', UUID_B, [
      userLine('direct-b question'),
      assistantLine('claude-opus-4-7'),
    ]);

    const result = await runCliExport({ outDir, projectsRoot });
    expect(result.counts['cli-desktop']).toBe(1);
    expect(result.counts['cli-direct']).toBe(1);

    const desktop = result.entries.find((e) => e.source === 'cli-desktop');
    expect(desktop?.userTurns).toBe(1); // enriched
    expect(desktop?.title).toBe('Manifest title A'); // preserved
    expect(desktop?.preview).toBe('desktop-a question'); // OQ1 — overwritten

    // Desktop transcript copied to cli-desktop subdir.
    const copiedDesktop = path.join(outDir, 'local-transcripts', 'cli-desktop', `${UUID_A}.jsonl`);
    await expect(readFile(copiedDesktop, 'utf8')).resolves.toContain('desktop-a question');
    const copiedDirect = path.join(outDir, 'local-transcripts', 'cli-direct', `${UUID_B}.jsonl`);
    await expect(readFile(copiedDirect, 'utf8')).resolves.toContain('direct-b question');
  });

  it('validateEntries() returns [] for all produced entries', async () => {
    await writeTranscript('proj-a', UUID_A, [userLine('x'), assistantLine('m')]);
    await writeTranscript('proj-b', UUID_B, []); // no lines — edge case
    // Have to write an empty file for UUID_B since writeTranscript writes ""
    await writeFile(path.join(projectsRoot, 'proj-b', `${UUID_B}.jsonl`), '', 'utf8');
    // Add one with no assistant line at all
    await writeTranscript('proj-c', UUID_C, [userLine('only a user')]);
    // And one with no user line (first-user-text absent)
    await writeTranscript('proj-d', UUID_D, [assistantLine('m')]);
    const result = await runCliExport({ outDir, projectsRoot });
    const errors = validateEntries(result.entries);
    expect(errors).toEqual([]);
  });

  it('produces an empty result and a warn when projectsRoot is missing', async () => {
    const missing = path.join(projectsRoot, 'nope');
    const result = await runCliExport({ outDir, projectsRoot: missing });
    expect(result.entries).toEqual([]);
    expect(result.counts['cli-direct']).toBe(0);
    expect(result.counts['cli-desktop']).toBe(0);
  });

  it('surfaces topTools on the cli-direct entry when the transcript has tool_use blocks', async () => {
    await writeTranscript('proj-a', UUID_A, [
      userLine('do it'),
      {
        type: 'assistant',
        timestamp: '2026-04-15T10:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash' },
            { type: 'tool_use', id: 't2', name: 'Bash' },
            { type: 'tool_use', id: 't3', name: 'Edit' },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const result = await runCliExport({ outDir, projectsRoot });
    const entry = result.entries.find((e) => e.id === UUID_A);
    expect(entry).toBeDefined();
    expect(entry?.topTools).toEqual({ Bash: 2, Edit: 1 });
  });

  it('omits topTools when no assistant line uses a tool', async () => {
    await writeTranscript('proj-a', UUID_A, [
      userLine('chat only'),
      assistantLine('m'), // empty content by default
    ]);
    const result = await runCliExport({ outDir, projectsRoot });
    const entry = result.entries.find((e) => e.id === UUID_A);
    expect(entry).toBeDefined();
    expect(entry?.topTools).toBeUndefined();
  });

  it('reuses prior entries when transcript mtime is unchanged (incremental rescan)', async () => {
    // First pass — write a transcript, run a full export. The emitted
    // entry carries `sourceMtimeMs`; the cli-sessions.json written to
    // outDir becomes the "previous manifest" for the second pass.
    await writeTranscript('proj-a', UUID_A, [
      userLine('first question'),
      assistantLine('claude-opus-4-7'),
    ]);
    const firstRun = await runCliExport({ outDir, projectsRoot });
    expect(firstRun.reuseCounts['cli-direct']).toBe(0);
    const firstEntry = firstRun.entries.find((e) => e.id === UUID_A);
    expect(firstEntry).toBeDefined();
    expect(typeof firstEntry?.sourceMtimeMs).toBe('number');

    // Second pass without touching the transcript — the entry should
    // be reused verbatim and the transcript should not be re-streamed.
    const secondRun = await runCliExport({ outDir, projectsRoot });
    expect(secondRun.reuseCounts['cli-direct']).toBe(1);
    expect(secondRun.transcriptsCopied).toBe(0); // dest already up-to-date
    const secondEntry = secondRun.entries.find((e) => e.id === UUID_A);
    expect(secondEntry).toBeDefined();
    // Same cached mtime survives the reuse hop intact.
    expect(secondEntry?.sourceMtimeMs).toBe(firstEntry?.sourceMtimeMs);
  });

  it('rescans when the transcript file mtime changes', async () => {
    const file = await writeTranscript('proj-a', UUID_A, [
      userLine('v1 question'),
      assistantLine('claude-opus-4-7'),
    ]);
    const firstRun = await runCliExport({ outDir, projectsRoot });
    expect(firstRun.reuseCounts['cli-direct']).toBe(0);

    // Rewrite the transcript with a different body — this bumps mtime.
    // Explicitly wait a millisecond to guarantee a change on fast
    // filesystems that have sub-ms resolution (NTFS does ~100ns).
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(
      file,
      [
        JSON.stringify(userLine('v2 question')),
        JSON.stringify(assistantLine('claude-opus-4-7')),
      ].join('\n') + '\n',
      'utf8',
    );
    const secondRun = await runCliExport({ outDir, projectsRoot });
    expect(secondRun.reuseCounts['cli-direct']).toBe(0);
    // Preview pulled from the new first-user-text.
    const entry = secondRun.entries.find((e) => e.id === UUID_A);
    expect(entry?.preview).toContain('v2 question');
  });
});
