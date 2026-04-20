import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CloudConversation, SessionManifest } from '@chat-arch/schema';
import type { UploadedCloudData } from '../types.js';
import {
  loadUploadedData,
  saveUploadedData,
  clearUploadedData,
  _resetStoreForTest,
} from './uploadedDataStore.js';

function manifest(): SessionManifest {
  return {
    schemaVersion: 1,
    generatedAt: 1_700_000_000_000,
    counts: { cloud: 1, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
    sessions: [
      {
        id: 'aaaa1111-1111-1111-1111-111111111111',
        source: 'cloud',
        rawSessionId: 'aaaa1111-1111-1111-1111-111111111111',
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        durationMs: 0,
        title: 'Persisted alpha',
        titleSource: 'cloud-name',
        preview: null,
        userTurns: 1,
        model: null,
        cwdKind: 'none',
        totalCostUsd: null,
      },
    ],
  } as SessionManifest;
}

function conversation(uuid: string): CloudConversation {
  return {
    uuid,
    name: `Conv ${uuid}`,
    summary: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    account: { uuid: 'u' },
    chat_messages: [],
  } as CloudConversation;
}

function archive(): UploadedCloudData {
  const m = new Map<string, CloudConversation>();
  m.set('aaaa1111-1111-1111-1111-111111111111', conversation('aaaa1111-1111-1111-1111-111111111111'));
  return {
    manifest: manifest(),
    conversationsById: m,
    sourceLabel: 'export.zip (12.0 KB)',
  };
}

// Each test starts fresh: clearing the lone key is enough to isolate cases
// (we don't need to delete the database itself, which would deadlock against
// the connection idb-keyval keeps open across tests).
beforeEach(async () => {
  await clearUploadedData();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uploadedDataStore', () => {
  it('returns null when nothing has been saved yet', async () => {
    const out = await loadUploadedData();
    expect(out).toBeNull();
  });

  it('round-trips an archive through save/load (Map preserved)', async () => {
    await saveUploadedData(archive());
    const out = await loadUploadedData();
    expect(out).not.toBeNull();
    expect(out!.manifest.sessions).toHaveLength(1);
    expect(out!.sourceLabel).toMatch(/export\.zip/);
    // structuredClone keeps Map; this is the whole reason for IDB over LS.
    expect(out!.conversationsById).toBeInstanceOf(Map);
    expect(out!.conversationsById.size).toBe(1);
    expect(out!.conversationsById.get('aaaa1111-1111-1111-1111-111111111111')?.name).toBe(
      'Conv aaaa1111-1111-1111-1111-111111111111',
    );
  });

  it('overwrites prior saves (last writer wins)', async () => {
    await saveUploadedData(archive());
    const second = archive();
    second.sourceLabel = 'newer.zip (24.0 KB)';
    await saveUploadedData(second);
    const out = await loadUploadedData();
    expect(out?.sourceLabel).toBe('newer.zip (24.0 KB)');
  });

  it('clearUploadedData removes the persisted entry', async () => {
    await saveUploadedData(archive());
    expect(await loadUploadedData()).not.toBeNull();
    await clearUploadedData();
    expect(await loadUploadedData()).toBeNull();
  });

  it('clearUploadedData is a no-op when nothing is stored', async () => {
    await expect(clearUploadedData()).resolves.toBeUndefined();
    expect(await loadUploadedData()).toBeNull();
  });

  it('returns null when the stored value fails the shape check', async () => {
    // Bypass the typed save to plant a corrupt entry, then verify load
    // collapses to null instead of returning the junk.
    const { set, createStore } = await import('idb-keyval');
    const store = createStore('chat-arch', 'uploaded-cloud-data');
    await set('archive', { manifest: 'not-an-object', sourceLabel: 7 }, store);
    const out = await loadUploadedData();
    expect(out).toBeNull();
  });

  it('returns null when manifest.sessions is missing', async () => {
    const { set, createStore } = await import('idb-keyval');
    const store = createStore('chat-arch', 'uploaded-cloud-data');
    await set(
      'archive',
      {
        manifest: { schemaVersion: 1, generatedAt: 0, counts: {} /* no sessions */ },
        conversationsById: new Map(),
        sourceLabel: 'partial.zip',
      },
      store,
    );
    expect(await loadUploadedData()).toBeNull();
  });

  it('returns null when manifest.sessions is the wrong type (object, not array)', async () => {
    // Downstream `effectiveManifest`/`mergeUploads` call `.filter`/`.sort`
    // on `sessions` — a non-array would crash the viewer mount. Make sure
    // the shape check catches this distinct failure mode.
    const { set, createStore } = await import('idb-keyval');
    const store = createStore('chat-arch', 'uploaded-cloud-data');
    await set(
      'archive',
      {
        manifest: {
          schemaVersion: 1,
          generatedAt: 0,
          counts: {},
          sessions: { not: 'an-array' },
        },
        conversationsById: new Map(),
        sourceLabel: 'wrong-type.zip',
      },
      store,
    );
    expect(await loadUploadedData()).toBeNull();
  });

  it('returns null when manifest.schemaVersion is missing', async () => {
    const { set, createStore } = await import('idb-keyval');
    const store = createStore('chat-arch', 'uploaded-cloud-data');
    await set(
      'archive',
      {
        manifest: { generatedAt: 0, counts: {}, sessions: [] },
        conversationsById: new Map(),
        sourceLabel: 'no-version.zip',
      },
      store,
    );
    expect(await loadUploadedData()).toBeNull();
  });

  it('returns null when IndexedDB is unavailable', async () => {
    const orig = globalThis.indexedDB;
    // @ts-expect-error — simulating an environment that lacks IndexedDB.
    delete globalThis.indexedDB;
    try {
      _resetStoreForTest();
      const out = await loadUploadedData();
      expect(out).toBeNull();
      // Save and clear should also no-op without throwing.
      await expect(saveUploadedData(archive())).resolves.toBeUndefined();
      await expect(clearUploadedData()).resolves.toBeUndefined();
    } finally {
      globalThis.indexedDB = orig;
      _resetStoreForTest();
    }
  });

  it('saveUploadedData swallows storage failures (does not reject)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // structuredClone (used by IDB) rejects values containing functions with
    // DataCloneError. Inject one to exercise the catch path without having
    // to mock the ESM module namespace.
    const bad = archive();
    (bad as unknown as Record<string, unknown>)['unserializable'] = () => undefined;
    await expect(saveUploadedData(bad)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
