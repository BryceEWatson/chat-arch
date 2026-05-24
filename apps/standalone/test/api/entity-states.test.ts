/**
 * Rev3-C C4 — pure-function tests for the entity-states endpoint.
 *
 * The persistence layer (SDK) is tested in
 * `packages/exporter/src/db/sdk/entityStates.test.ts`. This file
 * tests the surface that's local to the endpoint module — the
 * validation helper.
 */
import { describe, expect, it } from 'vitest';
import {
  validateEntityStateBody,
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
