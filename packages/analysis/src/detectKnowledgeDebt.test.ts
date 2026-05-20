import { describe, it, expect } from 'vitest';
import {
  detectKnowledgeDebt,
  renderObsidianMarkdown,
  type KnowledgeDebtEntry,
} from './detectKnowledgeDebt.js';

/**
 * Build a deterministic unit-length embedding for a cluster id. Three
 * one-hot directions in a 3-D space — each cluster is orthogonal to the
 * others by construction. With intra-cluster cosine = 1.0 (same vector
 * for all members), every cluster easily clears the default 0.7 floor.
 */
function clusterEmbedding(clusterIdx: 0 | 1 | 2): Float32Array {
  const v = new Float32Array(3);
  v[clusterIdx] = 1;
  return v;
}

function entry(
  sessionId: string,
  text: string,
  clusterIdx: 0 | 1 | 2,
  ts: number,
  withEmbedding: boolean,
): KnowledgeDebtEntry {
  const base: KnowledgeDebtEntry = {
    sessionId,
    firstUserTurn: text,
    timestamp: ts,
  };
  if (withEmbedding) base.embedding = clusterEmbedding(clusterIdx);
  return base;
}

describe('detectKnowledgeDebt — high-confidence (embedding) path', () => {
  it('returns 3 clusters of 10 with correct session-id grouping', () => {
    const entries: KnowledgeDebtEntry[] = [];
    for (let i = 0; i < 10; i += 1) {
      entries.push(entry(`a-${i}`, `how do I set up terraform plan ${i}`, 0, 1_000 + i, true));
    }
    for (let i = 0; i < 10; i += 1) {
      entries.push(entry(`b-${i}`, `migrate database schema upgrade ${i}`, 1, 2_000 + i, true));
    }
    for (let i = 0; i < 10; i += 1) {
      entries.push(entry(`c-${i}`, `regenerate openapi client typescript ${i}`, 2, 3_000 + i, true));
    }

    const clusters = detectKnowledgeDebt(entries);
    expect(clusters).toHaveLength(3);
    for (const c of clusters) {
      expect(c.sessionIds).toHaveLength(10);
      expect(c.confidence).toBe('high');
    }

    // Each cluster's session ids should all share a single prefix.
    for (const c of clusters) {
      const prefixes = new Set(c.sessionIds.map((s) => s[0]));
      expect(prefixes.size).toBe(1);
    }

    // firstSeen / lastSeen line up with the timestamps we seeded.
    const byPrefix = new Map<string, ReturnType<typeof detectKnowledgeDebt>[number]>();
    for (const c of clusters) byPrefix.set(c.sessionIds[0]![0]!, c);
    expect(byPrefix.get('a')!.firstSeen).toBe(1_000);
    expect(byPrefix.get('a')!.lastSeen).toBe(1_009);
  });

  it('respects minClusterSize override', () => {
    const entries: KnowledgeDebtEntry[] = [];
    for (let i = 0; i < 4; i += 1) {
      entries.push(entry(`a-${i}`, `terraform plan ${i}`, 0, 1_000 + i, true));
    }
    // Below default minClusterSize (10) → empty.
    expect(detectKnowledgeDebt(entries)).toHaveLength(0);
    // Lower the floor → cluster surfaces.
    expect(detectKnowledgeDebt(entries, { minClusterSize: 3 })).toHaveLength(1);
  });

  it('returns empty when all texts are blank', () => {
    const entries: KnowledgeDebtEntry[] = [];
    for (let i = 0; i < 10; i += 1) {
      entries.push(entry(`a-${i}`, '   ', 0, 1_000 + i, true));
    }
    expect(detectKnowledgeDebt(entries)).toHaveLength(0);
  });
});

describe('detectKnowledgeDebt — TF-IDF fallback path (no embeddings)', () => {
  it('clusters by shared vocabulary and marks confidence low', () => {
    const aText = 'terraform plan apply infrastructure provisioning';
    const bText = 'database schema migration upgrade postgres';
    const cText = 'openapi typescript client codegen regenerate';
    const entries: KnowledgeDebtEntry[] = [];
    for (let i = 0; i < 10; i += 1) {
      entries.push(entry(`a-${i}`, aText, 0, 1_000 + i, false));
    }
    for (let i = 0; i < 10; i += 1) {
      entries.push(entry(`b-${i}`, bText, 1, 2_000 + i, false));
    }
    for (let i = 0; i < 10; i += 1) {
      entries.push(entry(`c-${i}`, cText, 2, 3_000 + i, false));
    }

    const clusters = detectKnowledgeDebt(entries);
    expect(clusters).toHaveLength(3);
    for (const c of clusters) {
      expect(c.confidence).toBe('low');
      expect(c.sessionIds).toHaveLength(10);
      // All session ids in a cluster share the same prefix.
      expect(new Set(c.sessionIds.map((s) => s[0])).size).toBe(1);
    }
  });

  it('downgrades the whole result to low confidence if any embedding is missing', () => {
    const entries: KnowledgeDebtEntry[] = [];
    for (let i = 0; i < 10; i += 1) {
      // First nine have embeddings; one doesn't — force fallback.
      const withEmb = i < 9;
      entries.push(entry(`a-${i}`, `terraform apply infra ${i}`, 0, 1_000 + i, withEmb));
    }
    const clusters = detectKnowledgeDebt(entries);
    // Cluster size of 10 lands; confidence should be low because one
    // entry was missing an embedding.
    for (const c of clusters) {
      expect(c.confidence).toBe('low');
    }
  });

  it('canonicalQuestion is one of the cluster members', () => {
    const entries: KnowledgeDebtEntry[] = [];
    for (let i = 0; i < 10; i += 1) {
      entries.push(entry(`a-${i}`, `terraform plan apply infra ${i}`, 0, 1_000 + i, false));
    }
    const clusters = detectKnowledgeDebt(entries);
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    const memberTexts = new Set(
      entries
        .filter((e) => cluster.sessionIds.includes(e.sessionId))
        .map((e) => e.firstUserTurn),
    );
    expect(memberTexts.has(cluster.canonicalQuestion)).toBe(true);
  });
});

describe('renderObsidianMarkdown', () => {
  it('emits YAML frontmatter with knowledge-debt tags', () => {
    const md = renderObsidianMarkdown([], { generatedAt: 1_700_000_000_000 });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('tags: [knowledge-debt]');
    expect(md).toContain('aliases: []');
    expect(md).toContain('created: 2023-11-14');
    expect(md).toContain('No recurring-question clusters');
  });

  it('renders one section per cluster with session count and dates', () => {
    const md = renderObsidianMarkdown(
      [
        {
          id: 'cl-aaaaaaaa',
          canonicalQuestion: 'how do I provision a vpc?',
          labelTerms: ['terraform', 'vpc', 'provision'],
          sessionIds: ['a-1', 'a-2', 'a-3'],
          firstSeen: 1_700_000_000_000,
          lastSeen: 1_700_100_000_000,
          confidence: 'high',
        },
      ],
      { generatedAt: 1_700_200_000_000 },
    );
    expect(md).toContain('## how do I provision a vpc?');
    expect(md).toContain('**Sessions:** 3');
    expect(md).toContain('**Confidence:** high');
    expect(md).toContain('terraform, vpc, provision');
  });
});
