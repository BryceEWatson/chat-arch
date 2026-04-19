import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateAudit } from '../../src/lib/audit.js';
import { logger } from '../../src/lib/logger.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `chat-arch-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpDir, { recursive: true });
  // Suppress logger output for these tests.
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeAuditFile(lines: readonly string[]): Promise<string> {
  const file = path.join(tmpDir, 'audit.jsonl');
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

describe('aggregateAudit', () => {
  it('counts user and assistant lines and returns undefined aggregates when no result line is present', async () => {
    const file = await writeAuditFile([
      JSON.stringify({ type: 'user', _audit_timestamp: 't' }),
      JSON.stringify({ type: 'assistant', _audit_timestamp: 't' }),
      JSON.stringify({ type: 'user', _audit_timestamp: 't' }),
    ]);
    const agg = await aggregateAudit(file);
    expect(agg.userTurns).toBe(2);
    expect(agg.assistantTurns).toBe(1);
    expect(agg.resultLineCount).toBe(0);
    expect(agg.durationMs).toBeUndefined();
    expect(agg.totalCostUsd).toBeUndefined();
    expect(agg.modelUsage).toBeUndefined();
    expect(agg.lastResultModel).toBeUndefined();
  });

  it('sums across multiple result lines (duration, cost, num_turns) and shallow-merges modelUsage', async () => {
    const file = await writeAuditFile([
      JSON.stringify({
        type: 'result',
        _audit_timestamp: 't',
        duration_ms: 1000,
        duration_api_ms: 600,
        num_turns: 5,
        total_cost_usd: 0.1,
        modelUsage: { 'claude-opus-4-6': { input: 10, output: 5 } },
      }),
      JSON.stringify({
        type: 'result',
        _audit_timestamp: 't',
        duration_ms: 2000,
        duration_api_ms: 1200,
        num_turns: 3,
        total_cost_usd: 0.2,
        modelUsage: { 'claude-haiku-4-5': { input: 5, output: 2 } },
      }),
    ]);
    const agg = await aggregateAudit(file);
    expect(agg.resultLineCount).toBe(2);
    expect(agg.durationMs).toBe(3000);
    expect(agg.durationApiMs).toBe(1800);
    expect(agg.numTurns).toBe(8);
    expect(agg.totalCostUsd).toBeCloseTo(0.3, 10);
    expect(agg.modelUsage).toEqual({
      'claude-opus-4-6': { input: 10, output: 5 },
      'claude-haiku-4-5': { input: 5, output: 2 },
    });
    // `lastResultModel` = last result's last modelUsage key.
    expect(agg.lastResultModel).toBe('claude-haiku-4-5');
  });

  it('skips malformed lines without throwing and counts them', async () => {
    const file = await writeAuditFile([
      JSON.stringify({ type: 'user', _audit_timestamp: 't' }),
      '{ this is not valid JSON',
      JSON.stringify({ type: 'assistant', _audit_timestamp: 't' }),
      '',
      'not-json-either',
    ]);
    const agg = await aggregateAudit(file);
    expect(agg.userTurns).toBe(1);
    expect(agg.assistantTurns).toBe(1);
    expect(agg.malformedLineCount).toBe(2); // empty line skipped, 2 malformed counted
  });

  it('tolerates audit lines with _audit_hmac fields (newer sessions)', async () => {
    const file = await writeAuditFile([
      JSON.stringify({ type: 'user', _audit_timestamp: 't', _audit_hmac: 'xyz' }),
      JSON.stringify({ type: 'assistant', _audit_timestamp: 't', _audit_hmac: 'xyz' }),
      JSON.stringify({
        type: 'result',
        _audit_timestamp: 't',
        duration_ms: 500,
        duration_api_ms: 300,
        num_turns: 1,
        total_cost_usd: 0.05,
        modelUsage: { 'claude-opus-4-7': {} },
        _audit_hmac: 'xyz',
      }),
    ]);
    const agg = await aggregateAudit(file);
    expect(agg.userTurns).toBe(1);
    expect(agg.totalCostUsd).toBe(0.05);
    expect(agg.lastResultModel).toBe('claude-opus-4-7');
  });

  it('ignores unknown line types without error', async () => {
    const file = await writeAuditFile([
      JSON.stringify({ type: 'tool_use_summary', _audit_timestamp: 't' }),
      JSON.stringify({ type: 'rate_limit_event', _audit_timestamp: 't' }),
      JSON.stringify({ type: 'system', subtype: 'init', _audit_timestamp: 't' }),
      JSON.stringify({ type: 'forward-compat-future-event', _audit_timestamp: 't' }),
    ]);
    const agg = await aggregateAudit(file);
    expect(agg.userTurns).toBe(0);
    expect(agg.assistantTurns).toBe(0);
    expect(agg.resultLineCount).toBe(0);
    expect(agg.malformedLineCount).toBe(0);
  });
});
