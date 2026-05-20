import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type {
  CompositeOutcome,
  CompositeOutcomesFile,
} from '@chat-arch/schema';
import { THRESHOLDS } from '@chat-arch/analysis';
import { EffectivenessMode } from './EffectivenessMode.js';

afterEach(() => cleanup());

const WEEK_MS = 7 * 86_400_000;
const WEIGHTS_HASH = 'test-hash-aaaa';

function outcome(
  sessionId: string,
  score: number,
  binary: CompositeOutcome['binary'],
): CompositeOutcome {
  return {
    sessionId,
    source: 'cloud',
    testPass: null,
    buildPass: null,
    prLand: null,
    noRework: null,
    affirmation: null,
    score,
    linearLogit: 0,
    binary,
    weightsHash: WEIGHTS_HASH,
  };
}

function buildFile(rows: CompositeOutcome[]): CompositeOutcomesFile {
  return {
    compositeVersion: 1,
    weightsVersion: 1,
    weights: THRESHOLDS.composite.weights,
    weightsHash: WEIGHTS_HASH,
    generatedAt: Date.UTC(2026, 3, 1),
    outcomes: rows,
    scannedSessionIds: rows.map((r) => r.sessionId),
  };
}

/**
 * Build a `minNForRate`-week trajectory with 10 sessions each week so
 * the display gate clears. EWMA + Wilson CI computed at render time.
 */
function buildFixture(): {
  outcomes: CompositeOutcomesFile;
  sessionUpdatedAt: ReadonlyMap<string, number>;
} {
  const startWeek = Date.UTC(2026, 0, 4); // a Sunday
  const rows: CompositeOutcome[] = [];
  const upd = new Map<string, number>();
  // 10 weeks, 10 sessions each, alternating good/bad pattern.
  for (let w = 0; w < 10; w += 1) {
    for (let s = 0; s < 10; s += 1) {
      const id = `s-${w}-${s}`;
      const isGood = (w + s) % 2 === 0;
      rows.push(outcome(id, isGood ? 0.7 : 0.3, isGood ? 'good' : 'bad'));
      upd.set(id, startWeek + w * WEEK_MS + s * 3600_000);
    }
  }
  return { outcomes: buildFile(rows), sessionUpdatedAt: upd };
}

const CAUSAL_TOKENS = [
  'because',
  'caused by',
  'due to',
  'effect of',
  'caused the',
  'because of',
];

function assertNoCausalLanguage(text: string): void {
  const lc = text.toLowerCase();
  for (const t of CAUSAL_TOKENS) {
    expect(lc.includes(t)).toBe(false);
  }
}

describe('EffectivenessMode', () => {
  it('renders the trajectory chart with fixture data (>=4 weeks)', () => {
    const { outcomes, sessionUpdatedAt } = buildFixture();
    const { container } = render(
      <EffectivenessMode
        outcomes={outcomes}
        sessionUpdatedAt={sessionUpdatedAt}
      />,
    );
    expect(screen.getAllByText('EFFECTIVENESS').length).toBeGreaterThan(0);
    // Two sparkline panels: MEAN COMPOSITE + GOOD SHARE.
    expect(container.querySelectorAll('.lcars-outcome-sparkline').length).toBe(2);
    // EWMA line is rendered per panel.
    expect(
      container.querySelectorAll('.lcars-outcome-sparkline__ewma').length,
    ).toBe(2);
  });

  it('renders the Wilson CI ribbon for the GOOD SHARE panel only', () => {
    const { outcomes, sessionUpdatedAt } = buildFixture();
    const { container } = render(
      <EffectivenessMode
        outcomes={outcomes}
        sessionUpdatedAt={sessionUpdatedAt}
      />,
    );
    // The MEAN panel passes showRibbon=false; only one ribbon path
    // should be present (the GOOD SHARE panel).
    expect(
      container.querySelectorAll('.lcars-outcome-sparkline__ribbon').length,
    ).toBe(1);
  });

  it('renders the empty state when no composite-outcomes file is provided', () => {
    render(
      <EffectivenessMode
        outcomes={null}
        sessionUpdatedAt={new Map()}
      />,
    );
    expect(screen.getByText('NO EFFECTIVENESS DATA')).toBeDefined();
  });

  it('renders the not-enough-data state below the minNForRate threshold', () => {
    // 3 weeks × 10 sessions — below the 8-week informative-weeks floor.
    const rows: CompositeOutcome[] = [];
    const upd = new Map<string, number>();
    const startWeek = Date.UTC(2026, 0, 4);
    for (let w = 0; w < 3; w += 1) {
      for (let s = 0; s < 10; s += 1) {
        const id = `s-${w}-${s}`;
        rows.push(outcome(id, 0.5, 'good'));
        upd.set(id, startWeek + w * WEEK_MS);
      }
    }
    render(
      <EffectivenessMode
        outcomes={buildFile(rows)}
        sessionUpdatedAt={upd}
      />,
    );
    expect(screen.getByText(/Not enough weekly data/i)).toBeDefined();
  });

  it('renders no causal language in the visible DOM text', () => {
    const { outcomes, sessionUpdatedAt } = buildFixture();
    const { container } = render(
      <EffectivenessMode
        outcomes={outcomes}
        sessionUpdatedAt={sessionUpdatedAt}
      />,
    );
    assertNoCausalLanguage(container.textContent ?? '');
  });

  it('expands the methodology disclosure on click', () => {
    const { outcomes, sessionUpdatedAt } = buildFixture();
    render(
      <EffectivenessMode
        outcomes={outcomes}
        sessionUpdatedAt={sessionUpdatedAt}
      />,
    );
    const toggle = screen.getByRole('button', {
      name: /methodology.*limitations/i,
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Caveats become visible after expansion.
    expect(screen.getByText('Confounding by indication')).toBeDefined();
    expect(screen.getByText('E-value caveats')).toBeDefined();
  });
});
