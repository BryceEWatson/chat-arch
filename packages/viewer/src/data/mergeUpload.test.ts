import { describe, it, expect } from 'vitest';
import type {
  AppliedImprovementsFile,
  CloudConversation,
  CorrectionsFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import type { UploadedCloudData } from '../types.js';
import { mergeUploads, effectiveManifest } from './mergeUpload.js';

function cloudEntry(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    durationMs: 0,
    title: `Conversation ${id}`,
    titleSource: 'cloud-name',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

function cliEntry(id: string, updatedAt = 1_700_000_000_000): UnifiedSessionEntry {
  return {
    id,
    source: 'cli-direct',
    rawSessionId: id,
    startedAt: updatedAt,
    updatedAt,
    durationMs: 0,
    title: `CLI ${id}`,
    titleSource: 'ai-title',
    preview: null,
    userTurns: 2,
    model: 'claude-opus-4-7',
    cwdKind: 'host',
    totalCostUsd: null,
  } as UnifiedSessionEntry;
}

function upload(
  entries: readonly UnifiedSessionEntry[],
  label: string,
  convs: Array<[string, Partial<CloudConversation>]> = [],
): UploadedCloudData {
  const conversationsById = new Map<string, CloudConversation>();
  for (const [id, partial] of convs) {
    conversationsById.set(id, {
      uuid: id,
      name: partial.name ?? `c-${id}`,
      created_at: partial.created_at ?? '2026-01-01T00:00:00.000Z',
      updated_at: partial.updated_at ?? '2026-01-01T00:00:00.000Z',
      chat_messages: partial.chat_messages ?? [],
      ...partial,
    } as CloudConversation);
  }
  return {
    manifest: {
      schemaVersion: 2,
      generatedAt: 1,
      counts: {
        cloud: entries.filter((e) => e.source === 'cloud').length,
        cowork: 0,
        'cli-direct': 0,
        'cli-desktop': 0,
      },
      sessions: entries,
    },
    conversationsById,
    sourceLabel: label,
  };
}

// ---------------------------------------------------------------------------
// mergeUploads
// ---------------------------------------------------------------------------

describe('mergeUploads', () => {
  it('returns the incoming upload verbatim when no prior upload exists', () => {
    const incoming = upload([cloudEntry('a'), cloudEntry('b')], 'first.zip');
    const out = mergeUploads(null, incoming);
    expect(out).toBe(incoming);
  });

  it('adds new conversations from a second ZIP without losing the first', () => {
    const first = upload([cloudEntry('a'), cloudEntry('b')], 'first.zip');
    const second = upload([cloudEntry('c'), cloudEntry('d')], 'second.zip');
    const out = mergeUploads(first, second);
    expect(out.manifest.sessions.map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(out.manifest.counts.cloud).toBe(4);
  });

  it('is idempotent when the same ZIP is uploaded twice', () => {
    const once = upload([cloudEntry('a'), cloudEntry('b')], 'dup.zip');
    const twice = upload([cloudEntry('a'), cloudEntry('b')], 'dup.zip');
    const out = mergeUploads(once, twice);
    expect(out.manifest.sessions.map((s) => s.id).sort()).toEqual(['a', 'b']);
    // Label dedupe keeps the single filename.
    expect(out.sourceLabel).toBe('dup.zip');
  });

  it('prefers the newer entry when the same id appears in both uploads', () => {
    const older = upload(
      [cloudEntry('a', { updatedAt: 1_700_000_000_000, title: 'Old title' })],
      'older.zip',
    );
    const newer = upload(
      [cloudEntry('a', { updatedAt: 1_700_001_000_000, title: 'New title' })],
      'newer.zip',
    );
    const out = mergeUploads(older, newer);
    expect(out.manifest.sessions).toHaveLength(1);
    expect(out.manifest.sessions[0]!.title).toBe('New title');
  });

  it('keeps the older entry when the incoming one is staler (defensive)', () => {
    const newer = upload(
      [cloudEntry('a', { updatedAt: 1_700_001_000_000, title: 'New title' })],
      'newer.zip',
    );
    const older = upload(
      [cloudEntry('a', { updatedAt: 1_700_000_000_000, title: 'Old title' })],
      'older.zip',
    );
    const out = mergeUploads(newer, older);
    expect(out.manifest.sessions).toHaveLength(1);
    expect(out.manifest.sessions[0]!.title).toBe('New title');
  });

  it('unions conversation bodies, preferring the body that matches the newer entry', () => {
    const older = upload([cloudEntry('a', { updatedAt: 1_700_000_000_000 })], 'older.zip', [
      ['a', { name: 'old body', updated_at: '2026-01-01T00:00:00.000Z' }],
    ]);
    const newer = upload([cloudEntry('a', { updatedAt: 1_700_001_000_000 })], 'newer.zip', [
      ['a', { name: 'new body', updated_at: '2026-01-02T00:00:00.000Z' }],
    ]);
    const out = mergeUploads(older, newer);
    expect(out.conversationsById.get('a')?.name).toBe('new body');
  });

  it('concatenates unique source labels with " + "', () => {
    const out = mergeUploads(
      upload([cloudEntry('a')], 'a.zip'),
      upload([cloudEntry('b')], 'b.zip'),
    );
    expect(out.sourceLabel).toBe('a.zip + b.zip');
  });

  it('sorts the merged sessions by updatedAt desc (newest first)', () => {
    const first = upload(
      [cloudEntry('a', { updatedAt: 1000 }), cloudEntry('b', { updatedAt: 3000 })],
      'a.zip',
    );
    const second = upload(
      [cloudEntry('c', { updatedAt: 2000 }), cloudEntry('d', { updatedAt: 4000 })],
      'b.zip',
    );
    const out = mergeUploads(first, second);
    expect(out.manifest.sessions.map((s) => s.id)).toEqual(['d', 'b', 'c', 'a']);
  });

  // -------------------------------------------------------------------------
  // Phase 4 P0.1 — preservation of optional fields across a merge.
  //
  // The literal-return shape of `mergeUploads` previously dropped
  // `corrections`, `appliedImprovements`, `synthesizedRescanDelta`, and
  // `projects` whenever a prior upload existed. That made the workshop
  // surface (corrections + applied-improvements panel + persistent
  // rescan-delta chip) silently disappear after a second LOAD DEMO DATA
  // click, or after a real ZIP upload following a demo.
  // -------------------------------------------------------------------------
  describe('Phase 4 — optional field preservation', () => {
    function demoCorrections(): CorrectionsFile {
      return {
        generatedAt: 1_700_000_000_000,
        corrections: [],
        patterns: [],
        pipeline: {
          heuristicRecall: true,
          llmClassification: true,
          embeddingClustering: true,
          claudeMdCrossCheck: true,
        },
      };
    }
    function demoApplied(): AppliedImprovementsFile {
      return {
        schemaVersion: 1,
        generatedAt: 1_700_000_000_000,
        entries: [],
      };
    }
    function demoUpload(
      sessionId: string,
      label: string,
      withDemoFields: boolean,
    ): UploadedCloudData {
      const base = upload([cloudEntry(sessionId)], label);
      if (!withDemoFields) return base;
      return {
        ...base,
        corrections: demoCorrections(),
        appliedImprovements: demoApplied(),
        synthesizedRescanDelta: { totalLocal: 12, cowork: 4, cli: 6, desktop: 2 },
      };
    }

    it('preserves Phase 4 fields from the existing upload when the incoming upload omits them', () => {
      // Simulates "click LOAD DEMO DATA, then upload a real ZIP that
      // doesn't carry corrections/applied" — the demo's workshop data
      // should survive (sourceLabel-side change is normal).
      const existing = demoUpload('a', 'demo.zip', true);
      const incoming = demoUpload('b', 'real.zip', false);
      const out = mergeUploads(existing, incoming);
      expect(out.corrections).toBe(existing.corrections);
      expect(out.appliedImprovements).toBe(existing.appliedImprovements);
      // Both sessions present.
      expect(out.manifest.sessions.map((s) => s.id).sort()).toEqual(['a', 'b']);
    });

    it('prefers incoming Phase 4 fields when both sides carry them (demo-twice scenario)', () => {
      // Simulates clicking LOAD DEMO DATA twice — the second click
      // should produce a coherent merged state (corrections from the
      // newer call, sessions union'd, etc).
      const existing = demoUpload('a', 'demo.zip', true);
      const incoming = demoUpload('a', 'demo.zip', true);
      const out = mergeUploads(existing, incoming);
      // The preference rule means out.corrections === incoming.corrections,
      // not the older one.
      expect(out.corrections).toBe(incoming.corrections);
      expect(out.appliedImprovements).toBe(incoming.appliedImprovements);
      expect(out.synthesizedRescanDelta).toEqual(incoming.synthesizedRescanDelta);
    });

    it('drops synthesizedRescanDelta when a real ZIP is uploaded after a demo', () => {
      // The synthesized delta is demo-only. A real cloud-zip upload
      // (parseCloudZip never sets the field) must wipe it so the chip
      // doesn't lie about a real upload's local-source counts.
      const existing = demoUpload('a', 'demo.zip', true);
      const incoming = demoUpload('b', 'real.zip', false);
      const out = mergeUploads(existing, incoming);
      expect(out.synthesizedRescanDelta).toBeUndefined();
      // But corrections + applied stay (real ZIPs don't carry them
      // either, but their loss isn't load-bearing — the on-disk
      // corrections.json fetch will fill them).
      expect(out.corrections).toBe(existing.corrections);
    });

    it('preserves projects when only the existing upload carries them', () => {
      // `projects` ships inside cloud export ZIPs (parseCloudZip),
      // so a hypothetical incoming upload missing projects shouldn't
      // erase the existing list.
      const projectList = [
        {
          uuid: 'p-1',
          name: 'demo project',
          description: 'd',
          is_private: false,
          is_starter_project: false,
          prompt_template: '',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          creator: { uuid: 'u', full_name: 'Demo User' },
          docs: [],
        },
      ] as const;
      const existing: UploadedCloudData = {
        ...upload([cloudEntry('a')], 'a.zip'),
        projects: projectList,
      };
      const incoming = upload([cloudEntry('b')], 'b.zip');
      const out = mergeUploads(existing, incoming);
      expect(out.projects).toBe(projectList);
    });

    it('first-upload short-circuit still returns the incoming reference verbatim', () => {
      // The `existing === null` branch sits before the merge logic and
      // must not change. (Defends against a regression where the spread
      // path runs even when there's nothing to spread over.)
      const incoming = demoUpload('a', 'demo.zip', true);
      const out = mergeUploads(null, incoming);
      expect(out).toBe(incoming);
    });
  });
});

// ---------------------------------------------------------------------------
// effectiveManifest
// ---------------------------------------------------------------------------

function fetched(sessions: readonly UnifiedSessionEntry[]): SessionManifest {
  const counts = {
    cloud: 0,
    cowork: 0,
    'cli-direct': 0,
    'cli-desktop': 0,
  };
  for (const s of sessions) counts[s.source] += 1;
  return {
    schemaVersion: 2,
    generatedAt: 0,
    counts,
    sessions,
  };
}

describe('effectiveManifest', () => {
  it('returns the fetched manifest when there is no upload', () => {
    const m = fetched([cliEntry('x'), cloudEntry('y')]);
    expect(effectiveManifest(m, null)).toBe(m);
  });

  it('returns the uploaded manifest when there is no fetched one', () => {
    const u = upload([cloudEntry('a')], 'u.zip');
    expect(effectiveManifest(null, u)).toBe(u.manifest);
  });

  it('keeps non-cloud fetched entries and replaces cloud entries with uploads', () => {
    const m = fetched([cliEntry('cli-1'), cloudEntry('cloud-old', { updatedAt: 1_000 })]);
    const u = upload([cloudEntry('cloud-new', { updatedAt: 2_000 })], 'u.zip');
    const out = effectiveManifest(m, u)!;
    const ids = out.sessions.map((s) => s.id).sort();
    // cli-1 kept, cloud-old dropped (replaced wholesale by upload), cloud-new added.
    expect(ids).toEqual(['cli-1', 'cloud-new']);
    expect(out.counts).toMatchObject({ cloud: 1, 'cli-direct': 1 });
  });

  it('passes cowork / cli-desktop fetched entries through unchanged', () => {
    const cowork = { ...cliEntry('w-1'), source: 'cowork' as const };
    const desktop = { ...cliEntry('k-1'), source: 'cli-desktop' as const };
    const m = fetched([cowork, desktop, cloudEntry('c-1')]);
    const u = upload([cloudEntry('c-2')], 'u.zip');
    const out = effectiveManifest(m, u)!;
    const ids = out.sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['c-2', 'k-1', 'w-1']);
  });

  it('merged sessions are sorted by updatedAt desc', () => {
    const m = fetched([cliEntry('cli-old', 1_000), cliEntry('cli-new', 5_000)]);
    const u = upload([cloudEntry('c-mid', { updatedAt: 3_000 })], 'u.zip');
    const out = effectiveManifest(m, u)!;
    expect(out.sessions.map((s) => s.id)).toEqual(['cli-new', 'c-mid', 'cli-old']);
  });
});
