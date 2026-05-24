// Phase Rev3-B sub-task B8: named gate test for the v1↔v2 Narrative
// schema migration. Plan reference:
//   "*Gate:* named `narrative.migration.test.ts` passes; existing
//    `validateNarrative()` accepts both schemaVersion shapes."
//
// This file pins the dual-version contract from B4 + the shape of v2
// rows from B1. The DB-side migration (B3, applied via the migration
// runner) is exercised in the exporter package's own test suite —
// here we test the schema-layer behavior (TS types + validateNarrative).

import { describe, it, expect } from 'vitest';

import {
  InvalidNarrativeError,
  validateNarrative,
  type Narrative,
} from './narrative.js';
import { UNASSIGNED_PROJECT_ID } from './project.js';

const ANCHOR_TS = '2026-05-23T00:00:00Z';

function baseV1(overrides: Partial<Narrative> = {}): Narrative {
  return {
    id: 'narr-v1',
    projectId: 'proj-1',
    sessionIds: ['s1'],
    sentiment: 'positive',
    title: 'Always set X before Y',
    body: 'Repeated observation.',
    evidence: [{ sessionId: 's1', anchor: 'turn:5', excerpt: 'short' }],
    generatedAt: ANCHOR_TS,
    actionType: 'encode-as-pattern',
    ...overrides,
  };
}

function baseV2(overrides: Partial<Narrative> = {}): Narrative {
  return {
    ...baseV1(),
    id: 'narr-v2',
    schemaVersion: 2,
    provenance: {
      intent: 'detect-repeated-X-before-Y',
      observation: 'X precedes Y in 5/7 sampled sessions',
      inference: 'X-before-Y is a stable workflow pattern for project',
    },
    attributedTo: 'deterministic',
    verifiedAt: null,
    confidence: 0.62,
    supportingCount: 5,
    contradictingCount: 1,
    correlatedOutcome: null,
    ...overrides,
  };
}

describe('Rev3-B narrative migration — dual-version contract', () => {
  describe('schemaVersion=1 (legacy) — back-compat acceptance', () => {
    it('passes for a well-formed v1 row (no provenance fields)', () => {
      expect(() => validateNarrative(baseV1())).not.toThrow();
    });

    it('treats absent schemaVersion as v1 (no provenance required)', () => {
      const n = baseV1();
      expect(n.schemaVersion).toBeUndefined();
      expect(() => validateNarrative(n)).not.toThrow();
    });

    it('explicit schemaVersion=1 is accepted', () => {
      const n = baseV1({ schemaVersion: 1 });
      expect(() => validateNarrative(n)).not.toThrow();
    });

    it('still rejects v1 rows that violate the pre-existing invariants', () => {
      // Pre-Rev3-B rules still apply on v1.
      expect(() =>
        validateNarrative(
          baseV1({ projectId: UNASSIGNED_PROJECT_ID, actionType: 'encode-as-pattern' }),
        ),
      ).toThrow(InvalidNarrativeError);
      expect(() =>
        validateNarrative(
          baseV1({ sentiment: 'positive', actionType: 'generate-corrective-prompt' }),
        ),
      ).toThrow(/actionType.*mismatches sentiment/);
    });
  });

  describe('schemaVersion=2 (Rev3-B) — provenance-shape acceptance', () => {
    it('passes for a fully-populated v2 row', () => {
      expect(() => validateNarrative(baseV2())).not.toThrow();
    });

    it('accepts verifiedAt=null on v2 (falsifier has not run yet)', () => {
      expect(() => validateNarrative(baseV2({ verifiedAt: null }))).not.toThrow();
    });

    it('accepts correlatedOutcome=null on v2 (below sig gate or not computed)', () => {
      expect(() => validateNarrative(baseV2({ correlatedOutcome: null }))).not.toThrow();
    });

    it('accepts the four attributedTo values', () => {
      for (const a of [
        'deterministic',
        'deterministic-with-prior',
        'llm-derived',
        'falsifier-verified',
      ] as const) {
        expect(() => validateNarrative(baseV2({ attributedTo: a }))).not.toThrow();
      }
    });
  });

  describe('schemaVersion=2 — structural rejections', () => {
    it('rejects v2 without provenance', () => {
      const n = baseV2({ provenance: undefined });
      expect(() => validateNarrative(n)).toThrow(/requires provenance/);
    });

    it('rejects v2 with empty intent / observation / inference', () => {
      for (const k of ['intent', 'observation', 'inference'] as const) {
        const provenance = { ...baseV2().provenance!, [k]: '' };
        expect(() => validateNarrative(baseV2({ provenance }))).toThrow(
          new RegExp(`empty provenance\\.${k}`),
        );
      }
    });

    it('rejects v2 without attributedTo', () => {
      expect(() => validateNarrative(baseV2({ attributedTo: undefined }))).toThrow(
        /requires attributedTo/,
      );
    });

    it('rejects confidence outside [0, 1]', () => {
      expect(() => validateNarrative(baseV2({ confidence: -0.01 }))).toThrow(
        /confidence must be a number in \[0,1\]/,
      );
      expect(() => validateNarrative(baseV2({ confidence: 1.01 }))).toThrow(
        /confidence must be a number in \[0,1\]/,
      );
    });

    it('rejects negative supporting/contradicting counts', () => {
      expect(() => validateNarrative(baseV2({ supportingCount: -1 }))).toThrow(
        /supportingCount must be a non-negative number/,
      );
      expect(() => validateNarrative(baseV2({ contradictingCount: -1 }))).toThrow(
        /contradictingCount must be a non-negative number/,
      );
    });

    it('rejects v2 with non-numeric confidence', () => {
      const n = baseV2({ confidence: 'high' as unknown as number });
      expect(() => validateNarrative(n)).toThrow(
        /confidence must be a number in \[0,1\]/,
      );
    });
  });

  describe('unknown schemaVersion', () => {
    it('rejects schemaVersion=3 (forward-incompat)', () => {
      const n = baseV2({ schemaVersion: 3 as unknown as 1 | 2 });
      expect(() => validateNarrative(n)).toThrow(/unknown schemaVersion 3/);
    });
  });

  describe('NarrativeEvidence (B2 turnIndex)', () => {
    it('accepts evidence rows with optional turnIndex', () => {
      const n = baseV2({
        evidence: [
          { sessionId: 's1', anchor: 'turn:3', excerpt: 'foo', turnIndex: 3 },
          { sessionId: 's2' }, // no turnIndex — still valid
        ],
      });
      expect(() => validateNarrative(n)).not.toThrow();
      expect(n.evidence[0]!.turnIndex).toBe(3);
      expect(n.evidence[1]!.turnIndex).toBeUndefined();
    });
  });
});
