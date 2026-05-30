import { describe, it, expect } from 'vitest';
import type { TokenTotals, UnifiedSessionEntry } from '@chat-arch/schema';
import { AUTOMATION_SIGNATURES } from '../classifyAutomation.js';
import {
  collapseAutomatedSessions,
  collapsedRowCountFields,
  collapsedRowUpdatedAt,
  asAutomationTemplateId,
  type CollapsedSessionRow,
} from './sessions.js';

/**
 * Minimal `UnifiedSessionEntry` factory — only the fields the collapse
 * selector reads (project, automationTemplateId, cost, tokens, temporal,
 * id) carry meaning; the rest satisfy the type with inert defaults.
 */
function entry(
  id: string,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cli-direct',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: `T ${id}`,
    titleSource: 'first-prompt',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

const tok = (n: number): TokenTotals => ({
  input: n,
  output: n,
  cacheCreation: n,
  cacheRead: n,
});

/** Pull the single automated row matching a template (test convenience). */
function automatedRows(rows: readonly CollapsedSessionRow[]) {
  return rows.filter(
    (r): r is Extract<CollapsedSessionRow, { kind: 'automated' }> =>
      r.kind === 'automated',
  );
}

describe('collapseAutomatedSessions', () => {
  it('returns an empty list for empty input', () => {
    expect(collapseAutomatedSessions([])).toEqual([]);
  });

  it('passes through an all-interactive list one row each, unchanged', () => {
    const a = entry('a', { project: 'p', updatedAt: 2 });
    const b = entry('b', { project: 'p', updatedAt: 1 });
    const rows = collapseAutomatedSessions([a, b]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'session')).toBe(true);
    // Sorted by updatedAt desc.
    expect(rows.map((r) => (r.kind === 'session' ? r.entry.id : ''))).toEqual([
      'a',
      'b',
    ]);
  });

  it('collapses N automated runs of one template into 1 row with instanceCount N + summed cost', () => {
    const sessions = [
      entry('s1', {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
        totalCostUsd: 0.1,
        tokenTotals: tok(10),
        startedAt: 100,
        updatedAt: 200,
      }),
      entry('s2', {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
        totalCostUsd: 0.2,
        tokenTotals: tok(20),
        startedAt: 50,
        updatedAt: 300,
      }),
      entry('s3', {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
        totalCostUsd: 0.3,
        tokenTotals: tok(30),
        startedAt: 150,
        updatedAt: 250,
      }),
    ];
    const rows = collapseAutomatedSessions(sessions);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.kind).toBe('automated');
    if (r.kind !== 'automated') throw new Error('unreachable');
    expect(r.instanceCount).toBe(3);
    expect(r.project).toBe('Command');
    expect(r.automationTemplateId).toBe('status-paragraph');
    // Label comes from AUTOMATION_SIGNATURES, not a hardcoded string.
    const sig = AUTOMATION_SIGNATURES.find((s) => s.templateId === 'status-paragraph');
    expect(r.label).toBe(sig!.label);
    expect(r.label).toBe('Project status paragraph');
    // Cost summed.
    expect(r.totalCostUsd).toBeCloseTo(0.6, 10);
    // Tokens summed element-wise.
    expect(r.tokenTotals).toEqual(tok(60));
    // startedAt = min, updatedAt = max.
    expect(r.startedAt).toBe(50);
    expect(r.updatedAt).toBe(300);
    // representative = most-recently-updated member (s2, updatedAt 300).
    expect(r.representative.id).toBe('s2');
  });

  it('sums the rate-table ESTIMATE across no-exact-cost members (preserves the cost signal)', () => {
    // The dominant case: cli-direct automated runs have totalCostUsd null +
    // a per-run costEstimatedUsd. The collapsed estimate MUST be the sum, not
    // one representative run's — regression guard for the signal-loss bug.
    const sessions = [
      entry('e1', {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
        totalCostUsd: null,
        costEstimatedUsd: 0.02,
      }),
      entry('e2', {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
        totalCostUsd: null,
        costEstimatedUsd: 0.03,
      }),
      entry('e3', {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
        totalCostUsd: null,
        costEstimatedUsd: 0.05,
      }),
    ];
    const [r] = automatedRows(collapseAutomatedSessions(sessions));
    expect(r!.instanceCount).toBe(3);
    // No exact cost anywhere → totalCostUsd null, summed estimate carried.
    expect(r!.totalCostUsd).toBeNull();
    expect(r!.costEstimatedUsd).toBeCloseTo(0.1, 10);
    // The count-fields projection surfaces the SUM (not the representative's).
    const fields = collapsedRowCountFields(r!);
    expect(fields.costEstimatedUsd).toBeCloseTo(0.1, 10);
  });

  it('keeps two templates in one project as two separate rows', () => {
    const sessions = [
      entry('a1', { project: 'Command', automationTemplateId: 'status-paragraph', updatedAt: 10 }),
      entry('a2', { project: 'Command', automationTemplateId: 'status-paragraph', updatedAt: 11 }),
      entry('b1', { project: 'Command', automationTemplateId: 'action-orchestration', updatedAt: 12 }),
    ];
    const auto = automatedRows(collapseAutomatedSessions(sessions));
    expect(auto).toHaveLength(2);
    const byTemplate = new Map(auto.map((r) => [r.automationTemplateId, r]));
    expect(byTemplate.get('status-paragraph')!.instanceCount).toBe(2);
    expect(byTemplate.get('action-orchestration')!.instanceCount).toBe(1);
  });

  it('keeps the same template across two projects as two separate rows', () => {
    const sessions = [
      entry('p1', { project: 'Alpha', automationTemplateId: 'test-probe', updatedAt: 1 }),
      entry('p2', { project: 'Alpha', automationTemplateId: 'test-probe', updatedAt: 2 }),
      entry('q1', { project: 'Beta', automationTemplateId: 'test-probe', updatedAt: 3 }),
    ];
    const auto = automatedRows(collapseAutomatedSessions(sessions));
    expect(auto).toHaveLength(2);
    const byProject = new Map(auto.map((r) => [r.project, r]));
    expect(byProject.get('Alpha')!.instanceCount).toBe(2);
    expect(byProject.get('Beta')!.instanceCount).toBe(1);
  });

  it('mixes interactive + automated: interactive pass through, automated collapse', () => {
    const sessions = [
      entry('human', { project: 'Command', updatedAt: 5 }),
      entry('auto1', { project: 'Command', automationTemplateId: 'status-paragraph', updatedAt: 6 }),
      entry('auto2', { project: 'Command', automationTemplateId: 'status-paragraph', updatedAt: 7 }),
    ];
    const rows = collapseAutomatedSessions(sessions);
    expect(rows).toHaveLength(2); // 1 interactive + 1 collapsed automated
    const sessionRows = rows.filter((r) => r.kind === 'session');
    const auto = automatedRows(rows);
    expect(sessionRows).toHaveLength(1);
    expect(auto).toHaveLength(1);
    expect(auto[0]!.instanceCount).toBe(2);
  });

  it('treats null-cost members as 0 but keeps a non-null sum when ANY member has cost', () => {
    const sessions = [
      entry('c1', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: null }),
      entry('c2', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: 0.5 }),
      entry('c3', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: null }),
    ];
    const r = automatedRows(collapseAutomatedSessions(sessions))[0]!;
    expect(r.totalCostUsd).toBeCloseTo(0.5, 10);
  });

  it('sets the group cost to null only when ALL members are null', () => {
    const sessions = [
      entry('n1', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: null }),
      entry('n2', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: null }),
    ];
    const r = automatedRows(collapseAutomatedSessions(sessions))[0]!;
    expect(r.totalCostUsd).toBeNull();
  });

  it('preserves a real $0 group cost (distinct from unknown null)', () => {
    const sessions = [
      entry('z1', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: 0 }),
      entry('z2', { project: 'Command', automationTemplateId: 'status-paragraph', totalCostUsd: 0 }),
    ];
    const r = automatedRows(collapseAutomatedSessions(sessions))[0]!;
    expect(r.totalCostUsd).toBe(0);
  });

  it('sets tokenTotals null only when no member carried tokens', () => {
    const sessions = [
      entry('t1', { project: 'Command', automationTemplateId: 'status-paragraph' }),
      entry('t2', { project: 'Command', automationTemplateId: 'status-paragraph' }),
    ];
    const r = automatedRows(collapseAutomatedSessions(sessions))[0]!;
    expect(r.tokenTotals).toBeNull();
  });

  it('buckets a missing/empty project under a null-project automated row', () => {
    const sessions = [
      entry('u1', { automationTemplateId: 'automated-envelope', updatedAt: 1 }),
      entry('u2', { project: '', automationTemplateId: 'automated-envelope', updatedAt: 2 }),
    ];
    const auto = automatedRows(collapseAutomatedSessions(sessions));
    expect(auto).toHaveLength(1);
    expect(auto[0]!.project).toBeNull();
    expect(auto[0]!.instanceCount).toBe(2);
  });

  it('falls back to the raw template id when it is not a known signature', () => {
    const sessions = [
      entry('x1', { project: 'Command', automationTemplateId: 'mystery-template' }),
    ];
    const r = automatedRows(collapseAutomatedSessions(sessions))[0]!;
    expect(r.label).toBe('mystery-template');
  });

  it('orders rows by updatedAt desc with a deterministic id tiebreaker', () => {
    const sessions = [
      entry('older', { project: 'p', updatedAt: 1 }),
      entry('newer', { project: 'p', updatedAt: 9 }),
      entry('autoA', { project: 'p', automationTemplateId: 'status-paragraph', updatedAt: 5 }),
    ];
    const rows = collapseAutomatedSessions(sessions);
    const order = rows.map((r) => collapsedRowUpdatedAt(r));
    expect(order).toEqual([9, 5, 1]);
  });
});

describe('asAutomationTemplateId', () => {
  it('narrows known template ids and rejects unknown ones', () => {
    expect(asAutomationTemplateId('status-paragraph')).toBe('status-paragraph');
    expect(asAutomationTemplateId('not-a-template')).toBeNull();
  });
});
