// Tests for Phase Rev3-G G2 correlation tag visibility gate.

import { describe, expect, it } from 'vitest';

import { THRESHOLDS } from './thresholds.js';
import {
  evaluateCorrelationTagVisibility,
} from './correlationTagGate.js';

describe('evaluateCorrelationTagVisibility', () => {
  it('shows the tag when both gates pass', () => {
    const r = evaluateCorrelationTagVisibility({
      stat: { t: 3.0, valid: true },
      evidenceLength: 10,
    });
    expect(r.visible).toBe(true);
    if (r.visible) {
      expect(r.absoluteTStat).toBe(3.0);
      expect(r.significanceThreshold).toBe(
        THRESHOLDS.curator.outcomeCorrelationSignificance,
      );
    }
  });

  it('hides the tag with insufficient-evidence reason when evidence < min', () => {
    const r = evaluateCorrelationTagVisibility({
      stat: { t: 5.0, valid: true }, // would pass significance
      evidenceLength: 2, // but evidence too small
    });
    expect(r.visible).toBe(false);
    if (!r.visible) {
      expect(r.reason).toBe('insufficient-evidence');
      if (r.reason === 'insufficient-evidence') {
        expect(r.evidenceLength).toBe(2);
        expect(r.evidenceMinLength).toBe(
          THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength,
        );
      }
    }
  });

  it('hides the tag with below-significance reason when |t| < threshold', () => {
    const r = evaluateCorrelationTagVisibility({
      stat: { t: 1.0, valid: true }, // |t| < 1.96
      evidenceLength: 10, // evidence sufficient
    });
    expect(r.visible).toBe(false);
    if (!r.visible) {
      expect(r.reason).toBe('below-significance');
    }
  });

  it('hides the tag with invalid-stat reason when test was degenerate', () => {
    const r = evaluateCorrelationTagVisibility({
      stat: { t: 0, valid: false },
      evidenceLength: 10,
    });
    expect(r.visible).toBe(false);
    if (!r.visible) {
      expect(r.reason).toBe('invalid-stat');
    }
  });

  it('check order: invalid > insufficient-evidence > below-significance', () => {
    // Both gates would fail; invalid wins.
    const invalid = evaluateCorrelationTagVisibility({
      stat: { t: 1.0, valid: false },
      evidenceLength: 2,
    });
    expect(invalid.visible).toBe(false);
    if (!invalid.visible) expect(invalid.reason).toBe('invalid-stat');

    // Valid stat, both evidence + significance fail → insufficient
    // first.
    const insufficient = evaluateCorrelationTagVisibility({
      stat: { t: 1.0, valid: true },
      evidenceLength: 2,
    });
    expect(insufficient.visible).toBe(false);
    if (!insufficient.visible) expect(insufficient.reason).toBe('insufficient-evidence');
  });

  it('uses |t| not signed t (effect direction doesn\'t change visibility)', () => {
    const positive = evaluateCorrelationTagVisibility({
      stat: { t: 2.5, valid: true },
      evidenceLength: 10,
    });
    const negative = evaluateCorrelationTagVisibility({
      stat: { t: -2.5, valid: true },
      evidenceLength: 10,
    });
    expect(positive.visible).toBe(true);
    expect(negative.visible).toBe(true);
  });

  it('boundary: evidence exactly at min is sufficient (inclusive)', () => {
    const r = evaluateCorrelationTagVisibility({
      stat: { t: 3.0, valid: true },
      evidenceLength: THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength,
    });
    expect(r.visible).toBe(true);
  });

  it('boundary: |t| exactly at significance is below (strict-less-than fails the gate)', () => {
    const r = evaluateCorrelationTagVisibility({
      stat: {
        t: THRESHOLDS.curator.outcomeCorrelationSignificance,
        valid: true,
      },
      evidenceLength: 10,
    });
    // Implementation uses `< threshold` for the "below" check, so
    // exactly-at-threshold counts as passing. Document the boundary
    // here so any future change is caught.
    expect(r.visible).toBe(true);
  });
});
