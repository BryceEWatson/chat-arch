import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateSubagents,
  sumTokens,
  sumHistograms,
  uniqueModels,
} from '../../src/lib/subagents.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-subagents-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('aggregateSubagents', () => {
  it('returns undefined when the subagents directory does not exist', async () => {
    expect(await aggregateSubagents(path.join(tmp, 'nope'))).toBeUndefined();
  });

  it('returns undefined when the directory exists but is empty', async () => {
    const dir = path.join(tmp, 'subagents');
    await mkdir(dir);
    expect(await aggregateSubagents(dir)).toBeUndefined();
  });

  it('walks two agent files, sums tokens, unions models, tallies tools', async () => {
    const dir = path.join(tmp, 'subagents');
    await mkdir(dir);

    const fileA = path.join(dir, 'agent-aaa.jsonl');
    await writeFile(
      fileA,
      [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'run task' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            content: [
              { type: 'text', text: 'ok' },
              { type: 'tool_use', id: 't1', name: 'Bash' },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 50,
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const fileB = path.join(dir, 'agent-bbb.jsonl');
    await writeFile(
      fileB,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [
              { type: 'tool_use', id: 't2', name: 'Bash' },
              { type: 'tool_use', id: 't3', name: 'Read' },
            ],
            usage: {
              input_tokens: 5,
              output_tokens: 7,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const rollup = await aggregateSubagents(dir);
    expect(rollup).toBeDefined();
    expect(rollup!.count).toBe(2);
    expect(rollup!.totalTokens).toEqual({
      input: 15,
      output: 27,
      cacheCreation: 100,
      cacheRead: 50,
    });
    expect([...rollup!.modelsUsed].sort()).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
    ]);
    expect(rollup!.topTools).toEqual({ Bash: 2, Read: 1 });
  });

  it('skips non-agent-*.jsonl files in the directory', async () => {
    const dir = path.join(tmp, 'subagents');
    await mkdir(dir);
    await writeFile(path.join(dir, 'agent-aaa.meta.json'), '{}', 'utf8');
    await writeFile(path.join(dir, 'README.md'), 'hi', 'utf8');
    // The .meta.json is metadata, not a JSONL transcript, so it must be ignored.
    // With no agent-*.jsonl files, rollup is undefined.
    expect(await aggregateSubagents(dir)).toBeUndefined();
  });

  it('silently skips malformed JSONL lines but keeps counting valid ones', async () => {
    const dir = path.join(tmp, 'subagents');
    await mkdir(dir);
    const file = path.join(dir, 'agent-xxx.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-haiku-4-5-20251001',
            content: [{ type: 'tool_use', id: 'a', name: 'Bash' }],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        }),
        '{ not valid json',
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-haiku-4-5-20251001',
            content: [{ type: 'tool_use', id: 'b', name: 'Edit' }],
            usage: { input_tokens: 3, output_tokens: 4 },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    const rollup = await aggregateSubagents(dir);
    expect(rollup!.count).toBe(1);
    expect(rollup!.totalTokens.input).toBe(4);
    expect(rollup!.totalTokens.output).toBe(6);
    expect(rollup!.topTools).toEqual({ Bash: 1, Edit: 1 });
  });
});

describe('helpers', () => {
  it('sumTokens adds the four counters', () => {
    expect(
      sumTokens(
        { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 },
        { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 },
      ),
    ).toEqual({ input: 11, output: 22, cacheCreation: 33, cacheRead: 44 });
  });

  it('sumHistograms adds matching keys, preserves unique keys', () => {
    expect(sumHistograms({ Bash: 1, Edit: 2 }, { Bash: 4, Read: 3 })).toEqual({
      Bash: 5,
      Edit: 2,
      Read: 3,
    });
  });

  it('uniqueModels preserves a-first insertion order and adds new from b', () => {
    expect(uniqueModels(['opus', 'sonnet'], ['sonnet', 'haiku'])).toEqual([
      'opus',
      'sonnet',
      'haiku',
    ]);
  });
});
