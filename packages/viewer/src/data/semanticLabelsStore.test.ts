import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { set as idbSet, createStore } from 'idb-keyval';
import {
  loadSemanticLabels,
  saveSemanticLabels,
  clearSemanticLabels,
  _resetSemanticLabelsStoreForTest,
} from './semanticLabelsStore.js';
import type { SemanticLabelsBundle } from './semanticClassify.js';

function makeBundle(overrides: Partial<SemanticLabelsBundle> = {}): SemanticLabelsBundle {
  return {
    version: 4,
    modelId: 'Xenova/bge-small-en-v1.5',
    mode: 'classify',
    options: { threshold: 0.4, margin: 0.02 },
    generatedAt: 1_700_000_000_000,
    labels: new Map(),
    analyzedSessionIds: new Set(['a', 'b', 'c']),
    device: 'webgpu',
    ...overrides,
  };
}

describe('semanticLabelsStore v4 guard', () => {
  beforeEach(async () => {
    _resetSemanticLabelsStoreForTest();
    await clearSemanticLabels();
  });

  it('round-trips a v4 bundle preserving analyzedSessionIds', async () => {
    const bundle = makeBundle();
    await saveSemanticLabels(bundle);
    const read = await loadSemanticLabels();
    expect(read).not.toBeNull();
    expect(read?.version).toBe(4);
    expect(read?.analyzedSessionIds).toBeInstanceOf(Set);
    expect([...(read?.analyzedSessionIds ?? [])]).toEqual(['a', 'b', 'c']);
  });

  it('rejects a legacy v3 bundle (lacks analyzedSessionIds)', async () => {
    // Plant a v3 shape directly via idb-keyval — simulates what
    // returning users have in IDB from the previous release.
    const store = createStore('chat-arch-semantic-labels', 'semantic-labels');
    const legacy = {
      version: 3,
      modelId: 'Xenova/bge-small-en-v1.5',
      mode: 'classify',
      options: { threshold: 0.4, margin: 0.02 },
      generatedAt: 1_700_000_000_000,
      labels: new Map(),
      device: 'webgpu',
    };
    await idbSet('active', legacy, store);

    // loader returns null — the viewer will then surface the ANALYZE
    // CTA and the user re-runs once to land a v4 bundle.
    const read = await loadSemanticLabels();
    expect(read).toBeNull();
  });

  it('rejects a v4-shaped row whose analyzedSessionIds is the wrong type', async () => {
    // Defensive check on deserialization: if a future bug serializes
    // the set as an array, the guard must treat it as invalid (the
    // cross-session math assumes Set semantics). Keep this test to
    // catch a class of "works in dev, breaks on reload" regressions.
    const store = createStore('chat-arch-semantic-labels', 'semantic-labels');
    const malformed = {
      ...makeBundle(),
      analyzedSessionIds: ['a', 'b', 'c'], // array, not Set
    };
    await idbSet('active', malformed, store);

    const read = await loadSemanticLabels();
    expect(read).toBeNull();
  });
});
