/**
 * Rev3-C C1+C2 — pure-function tests for the entity-states endpoint.
 *
 * Exercises:
 *   - validateEntityStateBody — accepts valid bodies, rejects
 *     malformed ones (unknown kinds, unknown states, missing ids,
 *     non-finite sizes)
 *   - upsertEntityState — inserts on new (kind, id), replaces in
 *     place on update, does NOT collide across kinds with the same
 *     entityId
 *   - loadEntityStatesLedger — back-compat reads from the legacy
 *     `knowledge-debt-states.json` shape when the v2 file is absent,
 *     synthesizing `entityKind: 'knowledge-debt'`
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadEntityStatesLedger,
  upsertEntityState,
  validateEntityStateBody,
  type EntityStatesFile,
} from '../../src/pages/api/entity-states.js';

describe('validateEntityStateBody', () => {
  it('accepts a valid knowledge-debt INSTALLED body', () => {
    const r = validateEntityStateBody({
      entityKind: 'knowledge-debt',
      entityId: 'k1',
      state: 'INSTALLED',
      sizeAtState: 12,
    });
    expect('error' in r).toBe(false);
  });

  it('accepts a valid narrative DISMISSED body', () => {
    const r = validateEntityStateBody({
      entityKind: 'narrative',
      entityId: 'narr-abc',
      state: 'DISMISSED',
      sizeAtState: 4,
    });
    expect('error' in r).toBe(false);
  });

  it('accepts PENDING and DISMISSED for both kinds', () => {
    for (const entityKind of ['knowledge-debt', 'narrative']) {
      for (const state of ['PENDING', 'DISMISSED']) {
        const r = validateEntityStateBody({
          entityKind,
          entityId: 'x',
          state,
          sizeAtState: 1,
        });
        expect('error' in r).toBe(false);
      }
    }
  });

  it('rejects unknown entityKind', () => {
    const r = validateEntityStateBody({
      entityKind: 'pattern',
      entityId: 'x',
      state: 'PENDING',
      sizeAtState: 1,
    });
    expect('error' in r).toBe(true);
  });

  it('rejects unknown state', () => {
    const r = validateEntityStateBody({
      entityKind: 'narrative',
      entityId: 'n1',
      state: 'bogus',
      sizeAtState: 1,
    });
    expect('error' in r).toBe(true);
  });

  it('rejects missing entityId', () => {
    const r = validateEntityStateBody({
      entityKind: 'narrative',
      state: 'INSTALLED',
      sizeAtState: 1,
    });
    expect('error' in r).toBe(true);
  });

  it('rejects oversized entityId', () => {
    const r = validateEntityStateBody({
      entityKind: 'narrative',
      entityId: 'a'.repeat(300),
      state: 'PENDING',
      sizeAtState: 1,
    });
    expect('error' in r).toBe(true);
  });

  it('rejects non-finite sizeAtState', () => {
    const r = validateEntityStateBody({
      entityKind: 'narrative',
      entityId: 'n1',
      state: 'PENDING',
      sizeAtState: 'huge',
    });
    expect('error' in r).toBe(true);
  });

  it('rejects non-object bodies', () => {
    expect('error' in validateEntityStateBody(null)).toBe(true);
    expect('error' in validateEntityStateBody(42)).toBe(true);
  });
});

describe('upsertEntityState', () => {
  const empty: EntityStatesFile = {
    schemaVersion: 2,
    generatedAt: 1000,
    entries: [],
  };

  it('appends a fresh entry', () => {
    const r = upsertEntityState(
      empty,
      {
        entityKind: 'knowledge-debt',
        entityId: 'k1',
        state: 'INSTALLED',
        sizeAtState: 7,
      },
      2000,
    );
    expect(r.next.entries.length).toBe(1);
    expect(r.next.entries[0]!.entityKind).toBe('knowledge-debt');
    expect(r.next.entries[0]!.entityId).toBe('k1');
    expect(r.next.entries[0]!.state).toBe('INSTALLED');
    expect(r.next.entries[0]!.sizeAtState).toBe(7);
    expect(r.next.entries[0]!.updatedAt).toBe(2000);
  });

  it('replaces an existing entry in place when (kind, id) matches', () => {
    const existing: EntityStatesFile = {
      schemaVersion: 2,
      generatedAt: 1000,
      entries: [
        {
          entityKind: 'knowledge-debt',
          entityId: 'k1',
          state: 'PENDING',
          updatedAt: 1,
          sizeAtState: 3,
        },
        {
          entityKind: 'narrative',
          entityId: 'n1',
          state: 'DISMISSED',
          updatedAt: 2,
          sizeAtState: 9,
        },
      ],
    };
    const r = upsertEntityState(
      existing,
      {
        entityKind: 'knowledge-debt',
        entityId: 'k1',
        state: 'DISMISSED',
        sizeAtState: 8,
      },
      3000,
    );
    expect(r.next.entries.length).toBe(2);
    expect(r.next.entries[0]!.state).toBe('DISMISSED');
    expect(r.next.entries[0]!.sizeAtState).toBe(8);
    expect(r.next.entries[0]!.updatedAt).toBe(3000);
    // The narrative entry is untouched.
    expect(r.next.entries[1]!.entityKind).toBe('narrative');
    expect(r.next.entries[1]!.entityId).toBe('n1');
    expect(r.next.entries[1]!.sizeAtState).toBe(9);
  });

  it('does NOT collide across kinds when entityId matches', () => {
    // Same entityId, different kinds → both entries must persist.
    const r1 = upsertEntityState(
      empty,
      {
        entityKind: 'knowledge-debt',
        entityId: 'shared-id',
        state: 'INSTALLED',
        sizeAtState: 5,
      },
      1000,
    );
    const r2 = upsertEntityState(
      r1.next,
      {
        entityKind: 'narrative',
        entityId: 'shared-id',
        state: 'DISMISSED',
        sizeAtState: 2,
      },
      2000,
    );
    expect(r2.next.entries.length).toBe(2);
    const kd = r2.next.entries.find((e) => e.entityKind === 'knowledge-debt');
    const narr = r2.next.entries.find((e) => e.entityKind === 'narrative');
    expect(kd?.state).toBe('INSTALLED');
    expect(narr?.state).toBe('DISMISSED');
  });
});

describe('loadEntityStatesLedger — back-compat read', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'entity-states-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty ledger when neither file exists', async () => {
    const result = await loadEntityStatesLedger(
      join(dir, 'entity-states.json'),
      join(dir, 'knowledge-debt-states.json'),
    );
    expect(result.schemaVersion).toBe(2);
    expect(result.entries).toEqual([]);
  });

  it('loads v2 ledger directly when present', async () => {
    const v2: EntityStatesFile = {
      schemaVersion: 2,
      generatedAt: 1500,
      entries: [
        {
          entityKind: 'narrative',
          entityId: 'n1',
          state: 'DISMISSED',
          updatedAt: 1500,
          sizeAtState: 3,
        },
      ],
    };
    await writeFile(
      join(dir, 'entity-states.json'),
      JSON.stringify(v2),
      'utf8',
    );
    const result = await loadEntityStatesLedger(
      join(dir, 'entity-states.json'),
      join(dir, 'knowledge-debt-states.json'),
    );
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.entityKind).toBe('narrative');
    expect(result.entries[0]!.entityId).toBe('n1');
  });

  it('falls back to legacy v1 ledger and migrates to v2 shape', async () => {
    const legacy = {
      schemaVersion: 1,
      generatedAt: 1200,
      entries: [
        {
          clusterId: 'kd-1',
          state: 'INSTALLED',
          updatedAt: 1200,
          sizeAtState: 8,
        },
        {
          clusterId: 'kd-2',
          state: 'DISMISSED',
          updatedAt: 1100,
          sizeAtState: 4,
        },
      ],
    };
    await writeFile(
      join(dir, 'knowledge-debt-states.json'),
      JSON.stringify(legacy),
      'utf8',
    );
    const result = await loadEntityStatesLedger(
      join(dir, 'entity-states.json'),
      join(dir, 'knowledge-debt-states.json'),
    );
    expect(result.schemaVersion).toBe(2);
    expect(result.entries.length).toBe(2);
    expect(result.entries.every((e) => e.entityKind === 'knowledge-debt')).toBe(true);
    const e0 = result.entries[0]!;
    expect(e0.entityId).toBe('kd-1');
    expect(e0.state).toBe('INSTALLED');
    expect(e0.sizeAtState).toBe(8);
    expect(e0.updatedAt).toBe(1200);
  });

  it('drops malformed legacy entries silently', async () => {
    const legacy = {
      schemaVersion: 1,
      generatedAt: 1200,
      entries: [
        { clusterId: 'ok', state: 'PENDING', updatedAt: 1, sizeAtState: 1 },
        { clusterId: '', state: 'PENDING', updatedAt: 1, sizeAtState: 1 },
        { clusterId: 'bad-state', state: 'NOPE', updatedAt: 1, sizeAtState: 1 },
        { clusterId: 'bad-size', state: 'PENDING', updatedAt: 1, sizeAtState: 'x' },
      ],
    };
    await writeFile(
      join(dir, 'knowledge-debt-states.json'),
      JSON.stringify(legacy),
      'utf8',
    );
    const result = await loadEntityStatesLedger(
      join(dir, 'entity-states.json'),
      join(dir, 'knowledge-debt-states.json'),
    );
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.entityId).toBe('ok');
  });

  it('v2 file takes precedence even if legacy file exists', async () => {
    const v2: EntityStatesFile = {
      schemaVersion: 2,
      generatedAt: 2000,
      entries: [
        {
          entityKind: 'narrative',
          entityId: 'fresh',
          state: 'INSTALLED',
          updatedAt: 2000,
          sizeAtState: 1,
        },
      ],
    };
    const legacy = {
      schemaVersion: 1,
      generatedAt: 1000,
      entries: [
        { clusterId: 'old', state: 'DISMISSED', updatedAt: 1000, sizeAtState: 5 },
      ],
    };
    await writeFile(
      join(dir, 'entity-states.json'),
      JSON.stringify(v2),
      'utf8',
    );
    await writeFile(
      join(dir, 'knowledge-debt-states.json'),
      JSON.stringify(legacy),
      'utf8',
    );
    const result = await loadEntityStatesLedger(
      join(dir, 'entity-states.json'),
      join(dir, 'knowledge-debt-states.json'),
    );
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.entityId).toBe('fresh');
  });
});
