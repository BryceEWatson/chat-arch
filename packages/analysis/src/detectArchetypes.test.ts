import { describe, it, expect } from 'vitest';
import { detectArchetypes, type SessionToolStats } from './detectArchetypes.js';

/**
 * Build a session with a specified tool-count profile. Fills in the
 * derived fields (longestSameToolRun, totalToolCalls) coherently so the
 * feature vector reflects the intended cluster shape.
 */
function makeSession(
  id: string,
  counts: Partial<Pick<SessionToolStats, 'readCount' | 'editCount' | 'bashCount' | 'grepCount' | 'globCount' | 'webFetchCount' | 'hasPlanTool'>>,
): SessionToolStats {
  const readCount = counts.readCount ?? 0;
  const editCount = counts.editCount ?? 0;
  const bashCount = counts.bashCount ?? 0;
  const grepCount = counts.grepCount ?? 0;
  const globCount = counts.globCount ?? 0;
  const webFetchCount = counts.webFetchCount ?? 0;
  const totalToolCalls = readCount + editCount + bashCount + grepCount + globCount + webFetchCount;
  const longestSameToolRun = Math.max(readCount, editCount, bashCount, grepCount, globCount, webFetchCount);
  return {
    sessionId: id,
    readCount,
    editCount,
    bashCount,
    grepCount,
    globCount,
    webFetchCount,
    longestSameToolRun,
    totalToolCalls,
    hasPlanTool: counts.hasPlanTool ?? false,
  };
}

describe('detectArchetypes', () => {
  it('returns empty result on empty input', () => {
    const result = detectArchetypes([]);
    expect(result.centroids).toEqual([]);
    expect(result.assignments).toEqual({});
    expect(Number.isNaN(result.silhouette)).toBe(true);
    expect(result.chosenK).toBe(0);
    expect(result.archetypeVersion).toBe(0);
  });

  it('finds three obvious clusters at silhouette >= 0.15', () => {
    const sessions: SessionToolStats[] = [];

    // Cluster A: read-heavy (research / exploration) — 25 sessions.
    for (let i = 0; i < 25; i++) {
      sessions.push(makeSession(`A-${i}`, { readCount: 30 + (i % 3), grepCount: 5 }));
    }
    // Cluster B: edit-heavy (focused coding) — 25 sessions.
    for (let i = 0; i < 25; i++) {
      sessions.push(makeSession(`B-${i}`, { editCount: 25 + (i % 3), readCount: 5 }));
    }
    // Cluster C: bash-heavy (devops / shell work) — 25 sessions.
    for (let i = 0; i < 25; i++) {
      sessions.push(makeSession(`C-${i}`, { bashCount: 28 + (i % 3), webFetchCount: 2 }));
    }

    const result = detectArchetypes(sessions, {
      kCandidates: [3, 4, 5],
      seed: 42,
      // archetypeMinSize default = 20; each true cluster has 25 -> survives.
    });

    expect(result.silhouette).toBeGreaterThanOrEqual(0.15);
    // 3 obvious clusters; chosen k should keep all three above the min-size guard.
    expect(result.centroids.length).toBeGreaterThanOrEqual(3);

    // Assignment integrity — every input session is mapped.
    expect(Object.keys(result.assignments).length).toBe(sessions.length);

    // No null assignments — every session lands in a surviving archetype.
    for (const v of Object.values(result.assignments)) {
      expect(v).not.toBeNull();
    }

    // Each true cluster (A/B/C) should map predominantly to ONE archetype.
    const aArchetypes = new Set(
      sessions.filter((s) => s.sessionId.startsWith('A-')).map((s) => result.assignments[s.sessionId]),
    );
    const bArchetypes = new Set(
      sessions.filter((s) => s.sessionId.startsWith('B-')).map((s) => result.assignments[s.sessionId]),
    );
    const cArchetypes = new Set(
      sessions.filter((s) => s.sessionId.startsWith('C-')).map((s) => result.assignments[s.sessionId]),
    );
    expect(aArchetypes.size).toBe(1);
    expect(bArchetypes.size).toBe(1);
    expect(cArchetypes.size).toBe(1);
    // And they're distinct archetypes.
    const distinct = new Set([...aArchetypes, ...bArchetypes, ...cArchetypes]);
    expect(distinct.size).toBe(3);
  });

  it('produces a stable archetypeVersion under same seed', () => {
    const sessions: SessionToolStats[] = [];
    for (let i = 0; i < 25; i++) sessions.push(makeSession(`A-${i}`, { readCount: 30, grepCount: 5 }));
    for (let i = 0; i < 25; i++) sessions.push(makeSession(`B-${i}`, { editCount: 25, readCount: 5 }));
    for (let i = 0; i < 25; i++) sessions.push(makeSession(`C-${i}`, { bashCount: 28 }));

    const a = detectArchetypes(sessions, { kCandidates: [3, 4, 5], seed: 42 });
    const b = detectArchetypes(sessions, { kCandidates: [3, 4, 5], seed: 42 });
    expect(a.archetypeVersion).toBe(b.archetypeVersion);
    expect(a.chosenK).toBe(b.chosenK);
  });

  it('silhouette gate: returns empty centroids + null assignments when best k falls below silhouetteFloor', () => {
    // Same well-clustered corpus from the "finds three obvious clusters"
    // test, but with an aggressive 0.99 floor that no realistic
    // clustering can clear. The silhouette gate should refuse to
    // emit centroids and null every assignment.
    const sessions: SessionToolStats[] = [];
    for (let i = 0; i < 25; i++) {
      sessions.push(makeSession(`A-${i}`, { readCount: 30 + (i % 3), grepCount: 5 }));
    }
    for (let i = 0; i < 25; i++) {
      sessions.push(makeSession(`B-${i}`, { editCount: 25 + (i % 3), readCount: 5 }));
    }
    for (let i = 0; i < 25; i++) {
      sessions.push(makeSession(`C-${i}`, { bashCount: 28 + (i % 3), webFetchCount: 2 }));
    }
    const result = detectArchetypes(sessions, {
      kCandidates: [3, 4, 5],
      seed: 42,
      silhouetteFloor: 0.99, // No 3-cluster solution on this corpus clears 0.99.
    });
    expect(result.centroids).toEqual([]);
    expect(Object.keys(result.assignments).length).toBe(sessions.length);
    for (const v of Object.values(result.assignments)) {
      expect(v).toBeNull();
    }
    // The observed silhouette + chosen k ARE reported (so a viewer
    // banner can surface "no signal at silhouette X.XX" rather than
    // silently disappearing).
    expect(result.chosenK).toBeGreaterThan(0);
    expect(Number.isFinite(result.silhouette)).toBe(true);
    expect(result.silhouette).toBeLessThan(0.99);
  });

  it('drops centroids below archetypeMinSize and reassigns to nearest', () => {
    const sessions: SessionToolStats[] = [];
    // Big cluster: 30 sessions (survives at minSize=20).
    for (let i = 0; i < 30; i++) sessions.push(makeSession(`big-${i}`, { readCount: 30 }));
    // Tiny cluster: 5 sessions (drops at minSize=20).
    for (let i = 0; i < 5; i++) sessions.push(makeSession(`small-${i}`, { editCount: 25, readCount: 5 }));
    // Another big cluster: 25 sessions.
    for (let i = 0; i < 25; i++) sessions.push(makeSession(`big2-${i}`, { bashCount: 28 }));

    const result = detectArchetypes(sessions, {
      kCandidates: [3],
      seed: 42,
      archetypeMinSize: 20,
    });
    // Only the two big clusters survive.
    expect(result.centroids.length).toBe(2);
    expect(result.centroids[0]!.sessionCount).toBeGreaterThanOrEqual(20);
    expect(result.centroids[1]!.sessionCount).toBeGreaterThanOrEqual(20);
    // The 5 small-* sessions are reassigned to one of the big archetypes (not null).
    for (let i = 0; i < 5; i++) {
      expect(result.assignments[`small-${i}`]).not.toBeNull();
    }
  });
});
