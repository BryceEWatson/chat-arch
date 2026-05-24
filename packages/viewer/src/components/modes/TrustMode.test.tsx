import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type {
  Decision,
  DecisionCandidate,
  DecisionsFile,
  DecisionTrustCalibration,
} from '@chat-arch/schema';
import { THRESHOLDS } from '@chat-arch/analysis';
import { TrustMode } from './TrustMode.js';

/**
 * TrustMode tests (Stream J #10):
 *   - 2×2 grid renders with cell counts.
 *   - Cells below minN are marked insufficient.
 *   - Mis-calibration flag fires ONLY when both rows clear minN AND
 *     the landed-rate CIs are disjoint.
 */

function candidate(id: string): DecisionCandidate {
  return {
    id,
    sessionId: `sess-${id}`,
    userTurnIndex: 0,
    kind: 'explicit-go-with',
    span: { phrase: 'x', startOffset: 0 },
    surroundingContext: 'ctx',
  };
}

function decision(
  id: string,
  tc: DecisionTrustCalibration,
): Decision {
  return {
    candidate: candidate(id),
    classification: {
      kind: 'explicit-go-with',
      distilledDecision: 'use X',
      chosen: ['X'],
      rejected: [],
      confidence: 0.7,
      actionable: true,
    },
    outcomeRef: {
      sessionId: `sess-${id}`,
      compositeScore: tc.landed ? 0.9 : 0.2,
      binaryClass: tc.landed ? 'good' : 'bad',
    },
    trustCalibration: tc,
  };
}

function file(decisions: readonly Decision[]): DecisionsFile {
  return {
    generatedAt: 1,
    decisionHeuristicVersion: 1,
    decisions,
    scannedSessionIds: [],
  };
}

function mix(
  acceptLanded: number,
  acceptNotLanded: number,
  overrideLanded: number,
  overrideNotLanded: number,
): Decision[] {
  const out: Decision[] = [];
  let i = 0;
  for (let k = 0; k < acceptLanded; k++)
    out.push(decision(`al${i++}`, { acceptedAssistant: true, landed: true }));
  for (let k = 0; k < acceptNotLanded; k++)
    out.push(decision(`an${i++}`, { acceptedAssistant: true, landed: false }));
  for (let k = 0; k < overrideLanded; k++)
    out.push(decision(`ol${i++}`, { acceptedAssistant: false, landed: true }));
  for (let k = 0; k < overrideNotLanded; k++)
    out.push(decision(`on${i++}`, { acceptedAssistant: false, landed: false }));
  return out;
}

afterEach(() => cleanup());

describe('TrustMode', () => {
  it('renders the empty state when file is null', () => {
    render(<TrustMode file={null} />);
    expect(screen.getByText('NO TRUST DATA')).toBeDefined();
  });

  it('renders the four 2×2 cells with their counts', () => {
    render(<TrustMode file={file(mix(3, 2, 1, 4))} />);
    expect(screen.getByTestId('trust-cell-accept-land').textContent).toContain('3');
    expect(screen.getByTestId('trust-cell-accept-noland').textContent).toContain('2');
    expect(screen.getByTestId('trust-cell-override-land').textContent).toContain('1');
    expect(screen.getByTestId('trust-cell-override-noland').textContent).toContain('4');
  });

  it('marks cells below minN as insufficient', () => {
    // 5 per cell — well under the threshold (minN = 30).
    render(<TrustMode file={file(mix(5, 5, 5, 5))} />);
    expect(
      screen
        .getByTestId('trust-cell-accept-land')
        .getAttribute('data-insufficient'),
    ).toBe('true');
  });

  it('does NOT fire the mis-calibration flag when CIs overlap', () => {
    // Equal rates → CIs heavily overlap.
    const minN = THRESHOLDS.trustCell.minN;
    render(
      <TrustMode
        file={file(mix(minN, minN, minN, minN))}
      />,
    );
    const flag = screen.getByTestId('miscalibration-flag');
    expect(flag.getAttribute('data-fired')).toBe('false');
    expect(flag.textContent).toMatch(/overlap|n <|No mis-calibration/);
  });

  it('fires the mis-calibration flag when both rows clear minN AND CIs are disjoint', () => {
    // accepted: 50 landed / 5 not landed → 50/55 ≈ 90.9%
    // overrode: 5 landed / 50 not landed →  5/55 ≈  9.1%
    // Both rows: per-cell minN=30 must be met for BOTH cells in BOTH
    // rows. Use 50/40 + 40/50 so cell-wise n >= 30 across the board.
    const decisions = mix(50, 40, 40, 50);
    // Flip half of the override-land cells to override-noland so rates differ.
    // To keep cells ≥30: accept 60/30 (rate ≈ 66.7%) vs override 30/60 (rate ≈ 33%).
    // CIs at n≈90 should be disjoint.
    const sample = mix(60, 30, 30, 60);
    render(<TrustMode file={file(sample)} />);
    const flag = screen.getByTestId('miscalibration-flag');
    expect(flag.getAttribute('data-fired')).toBe('true');
    expect(flag.textContent).toMatch(/Mis-calibration/);
    // Ignore the unused `decisions` placeholder — left in for readability.
    expect(decisions.length).toBeGreaterThan(0);
  });

  it('hides the rate when a cell in the row is below minN', () => {
    // accept row qualifies, override row has cell n=5 < minN.
    const minN = THRESHOLDS.trustCell.minN;
    render(<TrustMode file={file(mix(minN, minN, 5, 5))} />);
    expect(screen.getByTestId('rate-override-hidden')).toBeDefined();
    // accept row should still show its rate.
    expect(screen.getByTestId('rate-accept')).toBeDefined();
  });
});
