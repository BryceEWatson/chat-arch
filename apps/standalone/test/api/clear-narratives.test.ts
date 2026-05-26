import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  REQUIRED_HEADER,
  isLocalOrigin,
  isNarrativeOrphan,
  rewriteNarrativesJson,
} from '../../src/pages/api/clear-narratives.js';

describe('clear-narratives — CSRF gate', () => {
  it('accepts loopback origins, rejects everything else', () => {
    expect(isLocalOrigin('http://localhost:4324')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1')).toBe(true);
    expect(isLocalOrigin('http://[::1]')).toBe(true);
    expect(isLocalOrigin(null)).toBe(false);
    expect(isLocalOrigin('http://example.com')).toBe(false);
    expect(isLocalOrigin('file:///')).toBe(false);
  });

  it('exposes a distinct X-Requested-With header from sibling endpoints', () => {
    expect(REQUIRED_HEADER).toBe('chat-arch-clear-narratives');
  });
});

describe('clear-narratives — isNarrativeOrphan allow-list', () => {
  it('matches narrative status files', () => {
    expect(isNarrativeOrphan('narrative-status-abc-123.json')).toBe(true);
    expect(
      isNarrativeOrphan(
        'narrative-status-1614337e-5e34-4bb9-b89d-0b1de98cc131.json',
      ),
    ).toBe(true);
  });

  it('matches both skill-side and exporter-side tmp orphans', () => {
    expect(isNarrativeOrphan('narratives.json.tmp.req-abc')).toBe(true);
    expect(isNarrativeOrphan('narratives.json.tmp-12345-1700000000-abc123')).toBe(true);
  });

  it('does NOT match narratives.json itself (the file is rewritten, not deleted)', () => {
    expect(isNarrativeOrphan('narratives.json')).toBe(false);
  });

  it('does NOT match narrative-candidates.json (Stage-1 INPUT, not output)', () => {
    expect(isNarrativeOrphan('narrative-candidates.json')).toBe(false);
  });

  it('rejects sibling analysis files we do NOT own', () => {
    expect(isNarrativeOrphan('manifest.json')).toBe(false);
    expect(isNarrativeOrphan('corrections.json')).toBe(false);
    expect(isNarrativeOrphan('correction-status-foo.json')).toBe(false);
    expect(isNarrativeOrphan('curator-feed.json')).toBe(false);
    expect(isNarrativeOrphan('persona-status-foo.json')).toBe(false);
    expect(isNarrativeOrphan('personas.json')).toBe(false);
    expect(isNarrativeOrphan('falsifier-verdicts.json')).toBe(false);
  });

  it('rejects look-alike names', () => {
    expect(isNarrativeOrphan('xnarrative-status-foo.json')).toBe(false);
    expect(isNarrativeOrphan('narrative-status-')).toBe(false);
    expect(isNarrativeOrphan('NARRATIVE-STATUS-foo.json')).toBe(false); // case-sensitive
    expect(isNarrativeOrphan('')).toBe(false);
  });

  it('rejects directory traversal in the name', () => {
    expect(isNarrativeOrphan('../etc/passwd')).toBe(false);
    expect(isNarrativeOrphan('narrative-status-../foo.json')).toBe(false);
    expect(isNarrativeOrphan('../narratives.json.tmp.x')).toBe(false);
  });
});

/**
 * The endpoint's narratives.json rewrite logic is the critical surface
 * — pin its behavior with a unit-level direct exercise of the same
 * helpers the endpoint calls (mergeNarrativeFamilies +
 * buildNarrativesFileObject + normalizeNarrativeRow + classifyAttribution).
 * Full HTTP-level coverage lives in the e2e harness alongside SCAN.
 */
describe('clear-narratives — narratives.json rewrite shape', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-clear-narratives-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeNarrativesJson(content: unknown): Promise<string> {
    const dir = path.join(tmpDir, 'analysis');
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, 'narratives.json');
    await writeFile(target, JSON.stringify(content, null, 2) + '\n', 'utf8');
    return target;
  }

  async function readNarrativesJson(p: string): Promise<unknown> {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
  }

  // Calls the endpoint's exported rewrite helper directly.
  async function rewriteViaEndpoint(p: string): Promise<{ removed: number }> {
    return rewriteNarrativesJson(p);
  }

  it('removes llm-derived rows while preserving deterministic rows', async () => {
    const heuristic = {
      id: 'narr_proj_x_positive_abc',
      projectId: 'proj_x',
      sessionIds: ['s1', 's2'],
      sentiment: 'positive',
      title: 'h title',
      body: 'h body',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      actionType: 'encode-as-pattern',
      schemaVersion: 1,
      attributedTo: 'deterministic',
    };
    const llm = {
      id: 'narr_llm_proj_x_xyz',
      projectId: 'proj_x',
      sessionIds: ['s3', 's4'],
      sentiment: 'positive',
      title: 'l title',
      body: 'l body',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      actionType: 'encode-as-pattern',
      schemaVersion: 2,
      attributedTo: 'llm-derived',
      provenance: { intent: 'i', observation: 'o', inference: 'inf' },
      confidence: 0.5,
      supportingCount: 2,
      contradictingCount: 0,
      verifiedAt: null,
    };
    const target = await writeNarrativesJson({
      generatedAt: 1716673200000,
      exporterVersion: '1.7.0',
      narratives: [heuristic, llm],
    });
    const { removed } = await rewriteViaEndpoint(target);
    expect(removed).toBe(1);
    const file = (await readNarrativesJson(target)) as {
      narratives: ReadonlyArray<{ id: string; attributedTo: string }>;
    };
    expect(file.narratives.map((n) => n.id)).toEqual([heuristic.id]);
  });

  it('preserves deterministic-with-prior rows (NOT just the strict deterministic literal)', async () => {
    const heur2 = {
      id: 'narr_proj_x_positive_def',
      projectId: 'proj_x',
      sessionIds: ['s1'],
      sentiment: 'positive',
      title: 'calibrated',
      body: 'b',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      actionType: 'encode-as-pattern',
      schemaVersion: 1,
      attributedTo: 'deterministic-with-prior',
    };
    const target = await writeNarrativesJson({
      narratives: [heur2],
    });
    await rewriteViaEndpoint(target);
    const file = (await readNarrativesJson(target)) as {
      narratives: ReadonlyArray<{ id: string }>;
    };
    expect(file.narratives.map((n) => n.id)).toEqual([heur2.id]);
  });

  it('removes falsifier-verified rows (still in the LLM family)', async () => {
    const verified = {
      id: 'narr_llm_proj_x_v',
      projectId: 'proj_x',
      sessionIds: ['s1', 's2'],
      sentiment: 'positive',
      title: 't',
      body: 'b',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      actionType: 'encode-as-pattern',
      schemaVersion: 2,
      attributedTo: 'falsifier-verified',
      provenance: { intent: 'i', observation: 'o', inference: 'inf' },
      confidence: 0.7,
      supportingCount: 3,
      contradictingCount: 0,
      verifiedAt: '2026-05-25T00:00:00Z',
    };
    const target = await writeNarrativesJson({ narratives: [verified] });
    const { removed } = await rewriteViaEndpoint(target);
    expect(removed).toBe(1);
    const file = (await readNarrativesJson(target)) as {
      narratives: ReadonlyArray<unknown>;
    };
    expect(file.narratives).toHaveLength(0);
  });

  it('round-trips unrecognized top-level keys via _passthrough', async () => {
    const heur = {
      id: 'narr_proj_x_positive_h',
      projectId: 'proj_x',
      sessionIds: ['s1'],
      sentiment: 'positive',
      title: 't',
      body: 'b',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      actionType: 'encode-as-pattern',
      schemaVersion: 1,
      attributedTo: 'deterministic',
    };
    const target = await writeNarrativesJson({
      narratives: [heur],
      futureField: 'v2-only-future-key',
      anotherFutureKey: { nested: true },
    });
    await rewriteViaEndpoint(target);
    const file = (await readNarrativesJson(target)) as Record<string, unknown>;
    expect(file['futureField']).toBe('v2-only-future-key');
    expect(file['anotherFutureKey']).toEqual({ nested: true });
  });

  it('clears skipped[] (a fresh narrative-mining run will rebuild it)', async () => {
    const heur = {
      id: 'narr_proj_x_positive_h',
      projectId: 'proj_x',
      sessionIds: ['s1'],
      sentiment: 'positive',
      title: 't',
      body: 'b',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      actionType: 'encode-as-pattern',
      schemaVersion: 1,
      attributedTo: 'deterministic',
    };
    const target = await writeNarrativesJson({
      narratives: [heur],
      skipped: [
        { projectId: 'proj_y', status: 'insufficient-corpus', reason: '9 < 20' },
      ],
    });
    await rewriteViaEndpoint(target);
    const file = (await readNarrativesJson(target)) as {
      skipped: readonly unknown[];
    };
    expect(file.skipped).toEqual([]);
  });

  it('preserves the thresholds snapshot', async () => {
    const snapshot = {
      minSessionsForLlm: 20,
      maxSessionsForCorpus: 200,
      minPerProject: 3,
      maxPerProject: 8,
      evidenceMinPerNarrative: 2,
      maxLlmUsdPerProject: 0.5,
    };
    const heur = {
      id: 'narr_proj_x_positive_h',
      projectId: 'proj_x',
      sessionIds: ['s1'],
      sentiment: 'positive',
      title: 't',
      body: 'b',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      actionType: 'encode-as-pattern',
      schemaVersion: 1,
      attributedTo: 'deterministic',
    };
    const target = await writeNarrativesJson({
      narratives: [heur],
      thresholds: snapshot,
    });
    await rewriteViaEndpoint(target);
    const file = (await readNarrativesJson(target)) as {
      thresholds: typeof snapshot;
    };
    expect(file.thresholds).toEqual(snapshot);
  });

  it('does NOT touch narrative-candidates.json (Stage-1 input is preserved)', async () => {
    const heur = {
      id: 'narr_proj_x_positive_h',
      projectId: 'proj_x',
      sessionIds: ['s1'],
      sentiment: 'positive',
      title: 't',
      body: 'b',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      actionType: 'encode-as-pattern',
      schemaVersion: 1,
      attributedTo: 'deterministic',
    };
    const target = await writeNarrativesJson({ narratives: [heur] });
    const candidatesPath = path.join(tmpDir, 'analysis', 'narrative-candidates.json');
    await writeFile(candidatesPath, '{"projects":[]}', 'utf8');
    await rewriteViaEndpoint(target);
    // narrative-candidates.json still exists.
    const s = await stat(candidatesPath);
    expect(s.isFile()).toBe(true);
  });
});
