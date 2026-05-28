import { describe, it, expect } from 'vitest';
import type { SessionManifest, UnifiedSessionEntry } from './unified.js';
import { CURRENT_SCHEMA_VERSION, UNTITLED_SESSION } from './unified.js';

/**
 * Spec §13 / decision D2 promise: v3 introduces foreign-key fields
 * (`projectId`, `topicIds`) on sessions and an `analysisSidecars`
 * map on the manifest, but v1 and v2 manifests must still parse.
 */
describe('SessionManifest back-compat', () => {
  it('CURRENT_SCHEMA_VERSION is 4', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
  });

  it('accepts a v1 manifest (no cost-estimate fields, no v2 sidecars)', () => {
    const v1: SessionManifest = {
      schemaVersion: 1,
      generatedAt: 1714521600000,
      counts: { cloud: 1, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
      sessions: [
        {
          id: 'a',
          source: 'cloud',
          rawSessionId: 'a',
          startedAt: 0,
          updatedAt: 0,
          durationMs: 0,
          title: UNTITLED_SESSION,
          titleSource: 'fallback',
          preview: null,
          userTurns: 0,
          model: null,
          cwdKind: 'none',
          totalCostUsd: null,
        },
      ],
    };
    const round = JSON.parse(JSON.stringify(v1)) as SessionManifest;
    expect(round.schemaVersion).toBe(1);
    expect(round.sessions).toHaveLength(1);
  });

  it('accepts a v2 manifest with cost-estimate fields', () => {
    const v2: SessionManifest = {
      schemaVersion: 2,
      generatedAt: 1714521600000,
      counts: { cloud: 0, cowork: 1, 'cli-direct': 0, 'cli-desktop': 0 },
      sessions: [
        {
          id: 'b',
          source: 'cowork',
          rawSessionId: 'local_b',
          startedAt: 0,
          updatedAt: 0,
          durationMs: 0,
          title: 't',
          titleSource: 'manifest',
          preview: null,
          userTurns: 1,
          model: 'claude-opus-4-6',
          cwdKind: 'vm',
          totalCostUsd: 0.5,
          costEstimatedUsd: 0.5,
          costIsEstimate: false,
        },
      ],
    };
    const round = JSON.parse(JSON.stringify(v2)) as SessionManifest;
    expect(round.schemaVersion).toBe(2);
    expect(round.sessions[0]?.costIsEstimate).toBe(false);
  });

  it('accepts a v3 manifest with FK fields and sidecars map', () => {
    const v3: SessionManifest = {
      schemaVersion: 3,
      generatedAt: 1714521600000,
      counts: { cloud: 0, cowork: 1, 'cli-direct': 0, 'cli-desktop': 0 },
      analysisSidecars: {
        projects: 'analysis/projects.json',
        topics: 'analysis/topics.json',
        narratives: 'analysis/narratives.json',
        patterns: 'analysis/patterns.json',
        practice: 'analysis/practice.json',
      },
      sessions: [
        {
          id: 'c',
          source: 'cowork',
          rawSessionId: 'local_c',
          startedAt: 0,
          updatedAt: 0,
          durationMs: 0,
          title: 't',
          titleSource: 'manifest',
          preview: null,
          userTurns: 1,
          model: 'claude-opus-4-6',
          cwdKind: 'vm',
          totalCostUsd: null,
          projectId: 'proj_abc',
          topicIds: ['topic_1', 'topic_2'],
        },
      ],
    };
    const round = JSON.parse(JSON.stringify(v3)) as SessionManifest;
    expect(round.schemaVersion).toBe(3);
    expect(round.sessions[0]?.projectId).toBe('proj_abc');
    expect(round.sessions[0]?.topicIds).toEqual(['topic_1', 'topic_2']);
    expect(round.analysisSidecars?.projects).toBe('analysis/projects.json');
  });

  it('accepts a v4 manifest with discoveryScore + v2-pipeline sidecars', () => {
    const v4: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 1714521600000,
      counts: { cloud: 0, cowork: 1, 'cli-direct': 0, 'cli-desktop': 0 },
      analysisSidecars: {
        projects: 'analysis/projects.json',
        embeddingsBin: 'analysis/embeddings.bin',
        embeddingsMeta: 'analysis/embeddings.meta.json',
        continuumHealth: 'analysis/continuum-health.json',
        duplicatesSemantic: 'analysis/duplicates.semantic.json',
        auditClaims: 'analysis/audit-claims.json',
        auditResults: 'analysis/audit-results.json',
        auditSummary: 'analysis/audit-summary.json',
        upgradeOutcomes: 'analysis/upgrade-outcomes.json',
        blogCandidates: 'analysis/blog-candidates.json',
        blogDraftsIndex: 'analysis/blog-drafts/index.json',
      },
      sessions: [
        {
          id: 'e',
          source: 'cowork',
          rawSessionId: 'local_e',
          startedAt: 0,
          updatedAt: 0,
          durationMs: 0,
          title: 't',
          titleSource: 'manifest',
          preview: null,
          userTurns: 1,
          model: 'claude-opus-4-7',
          cwdKind: 'vm',
          totalCostUsd: null,
          discoveryScore: 0.82,
        },
      ],
    };
    const round = JSON.parse(JSON.stringify(v4)) as SessionManifest;
    expect(round.schemaVersion).toBe(4);
    expect(round.sessions[0]?.discoveryScore).toBe(0.82);
    expect(round.analysisSidecars?.embeddingsBin).toBe('analysis/embeddings.bin');
    expect(round.analysisSidecars?.auditSummary).toBe('analysis/audit-summary.json');
  });

  it('accepts the Project Identity v2 optional fields at schemaVersion 4 (no version bump)', () => {
    const entry: UnifiedSessionEntry = {
      id: 'f',
      source: 'cowork',
      rawSessionId: 'local_f',
      startedAt: 0,
      updatedAt: 0,
      durationMs: 0,
      title: 'Mar 28 – Shopforge daily metrics sync',
      titleSource: 'manifest',
      preview: null,
      userTurns: 1,
      model: 'claude-opus-4-7',
      cwdKind: 'vm',
      totalCostUsd: null,
      // Project Identity v2 additive optional fields:
      scheduledTaskId: 'shopforge-daily-metrics-sync',
      sessionType: 'scheduled',
      parentSessionId: 'parent-uuid',
      projectAttribution: { resolvedVia: 'scheduled-task', confidence: 0.9 },
    };
    const v4: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 1714521600000,
      counts: { cloud: 0, cowork: 1, 'cli-direct': 0, 'cli-desktop': 0 },
      sessions: [entry],
    };
    const round = JSON.parse(JSON.stringify(v4)) as SessionManifest;
    expect(round.schemaVersion).toBe(4);
    const s = round.sessions[0];
    expect(s?.scheduledTaskId).toBe('shopforge-daily-metrics-sync');
    expect(s?.sessionType).toBe('scheduled');
    expect(s?.parentSessionId).toBe('parent-uuid');
    expect(s?.projectAttribution).toEqual({ resolvedVia: 'scheduled-task', confidence: 0.9 });
    // CURRENT_SCHEMA_VERSION stays 4 — the new fields are optional, no bump.
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
  });

  it('UnifiedSessionEntry accepts v3 FK fields without losing v1 minimal shape', () => {
    const minimal: UnifiedSessionEntry = {
      id: 'd',
      source: 'cloud',
      rawSessionId: 'd',
      startedAt: 0,
      updatedAt: 0,
      durationMs: 0,
      title: UNTITLED_SESSION,
      titleSource: 'fallback',
      preview: null,
      userTurns: 0,
      model: null,
      cwdKind: 'none',
      totalCostUsd: null,
    };
    expect(minimal.projectId).toBeUndefined();
    expect(minimal.topicIds).toBeUndefined();
  });
});
