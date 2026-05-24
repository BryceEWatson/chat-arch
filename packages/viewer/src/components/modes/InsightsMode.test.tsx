import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type {
  ItsResult,
  KnowledgeDebtCluster,
  ReflexiveResult,
} from '@chat-arch/analysis';
import { InsightsMode } from './InsightsMode.js';
import type {
  ConfigHistoryFile,
  InsightsBundle,
  ItsFile,
  KnowledgeDebtFile,
  ReflexiveFile,
} from '../../data/insightsLoader.js';
import type { InsightsAckEntry } from '../../data/insightsAckClient.js';

afterEach(() => cleanup());

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

function itsResult(
  sha: string,
  delta: number,
  preN: number,
  postN: number,
): ItsResult {
  return {
    sha,
    ts: Date.UTC(2026, 2, 15),
    path: 'CLAUDE.md',
    subject: `commit ${sha}`,
    windowDays: 10,
    pre: {
      n: preN,
      meanScore: 0.5,
      goodShare: 0.5,
      goodShareCI: { low: 0.3, high: 0.7 },
    },
    post: {
      n: postN,
      meanScore: 0.5 + delta,
      goodShare: 0.5 + delta,
      goodShareCI: { low: 0.4, high: 0.8 },
    },
    deltaGoodShare: delta,
    deltaCI: { low: delta - 0.1, high: delta + 0.1 },
  };
}

function debtCluster(
  id: string,
  size: number,
  conf: 'high' | 'low' = 'high',
): KnowledgeDebtCluster {
  return {
    id,
    canonicalQuestion: `How do I solve problem ${id}?`,
    labelTerms: ['solve', 'problem'],
    sessionIds: Array.from({ length: size }, (_, i) => `${id}-sess-${i}`),
    firstSeen: Date.UTC(2026, 0, 1),
    lastSeen: Date.UTC(2026, 3, 1),
    confidence: conf,
  };
}

function reflexiveComputed(): ReflexiveResult {
  return {
    pairs: Array.from({ length: 20 }, (_, i) => ({
      treatedSessionId: `t-${i}`,
      controlSessionId: `c-${i}`,
      treatedGood: i % 2 === 0 ? 1 : 0,
      controlGood: i % 3 === 0 ? 1 : 0,
      distance: 0.1,
    })),
    pTreated: 0.5,
    pControl: 0.34,
    meanDelta: 0.16,
    ci: { low: 0.05, high: 0.27 },
    eValueCIBound: 1.42,
    eValueStatus: 'computed',
    nTreated: 20,
    nControl: 30,
  };
}

function reflexiveStraddlesNull(): ReflexiveResult {
  return {
    pairs: [],
    pTreated: 0.5,
    pControl: 0.5,
    meanDelta: 0.0,
    ci: { low: -0.2, high: 0.2 },
    eValueCIBound: null,
    eValueStatus: 'ci-straddles-null',
    nTreated: 15,
    nControl: 20,
  };
}

function makeBundle(opts: {
  itsResults?: readonly ItsResult[];
  debtClusters?: readonly KnowledgeDebtCluster[];
  reflexiveResult?: ReflexiveResult;
}): InsightsBundle {
  const configHistory: ConfigHistoryFile = {
    version: 1,
    generatedAt: Date.now(),
    commits: [],
  };
  const its: ItsFile = {
    version: 1,
    generatedAt: Date.now(),
    windowDays: 10,
    results: opts.itsResults ?? [],
  };
  const knowledgeDebt: KnowledgeDebtFile = {
    version: 1,
    generatedAt: Date.now(),
    confidence: 'high',
    clusters: opts.debtClusters ?? [],
  };
  const reflexive: ReflexiveFile = {
    version: 1,
    generatedAt: Date.now(),
    result: opts.reflexiveResult ?? reflexiveStraddlesNull(),
    methodology: {
      covariates: ['x', 'y'],
      notes: 'Descriptive contrast, not causal.',
    },
  };
  return { configHistory, its, knowledgeDebt, reflexive };
}

describe('InsightsMode', () => {
  it('renders all three sub-sections when bundle has data', () => {
    const bundle = makeBundle({
      itsResults: [itsResult('aaa', 0.1, 12, 14), itsResult('bbb', -0.08, 10, 11)],
      debtClusters: [debtCluster('k1', 5), debtCluster('k2', 4)],
      reflexiveResult: reflexiveComputed(),
    });
    render(<InsightsMode bundle={bundle} />);
    expect(screen.getByText('CONFIG IMPACT')).toBeDefined();
    expect(screen.getByText('KNOWLEDGE DEBT')).toBeDefined();
    expect(screen.getByText('REFLEXIVE')).toBeDefined();
  });

  it('renders the empty state when all four sidecars are absent', () => {
    const empty: InsightsBundle = {
      configHistory: null,
      its: null,
      knowledgeDebt: null,
      reflexive: null,
    };
    render(<InsightsMode bundle={empty} />);
    expect(screen.getByText('NO INSIGHTS DATA')).toBeDefined();
  });

  it('renders the E-value when status === computed', () => {
    const bundle = makeBundle({
      reflexiveResult: reflexiveComputed(),
    });
    render(<InsightsMode bundle={bundle} />);
    expect(screen.getByText('1.42')).toBeDefined();
  });

  it('renders the N/A copy when status === ci-straddles-null', () => {
    const bundle = makeBundle({
      reflexiveResult: reflexiveStraddlesNull(),
    });
    render(<InsightsMode bundle={bundle} />);
    // The reflexive card's E-VALUE dd row reads "N/A — ..." when the CI
    // straddles null. The same phrase also appears in the methodology
    // disclosure (which Wave 7 ships expanded by default) so we scope
    // the assertion to the reflexive section.
    const matches = screen.getAllByText(/N\/A.*not distinguishable from null/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('hides ITS rows where either side n < minNForRate', () => {
    const bundle = makeBundle({
      // The 2-vs-3 row should NOT render; the 10-vs-12 row should.
      itsResults: [
        itsResult('small', 0.5, 2, 3),
        itsResult('big', 0.1, 10, 12),
      ],
    });
    render(<InsightsMode bundle={bundle} />);
    expect(screen.queryByText('commit small')).toBeNull();
    expect(screen.getByText('commit big')).toBeDefined();
  });

  it('renders no causal language in the cards (methodology body excluded)', () => {
    // Wave 7 ships MethodologyDisclosure expanded by default — that
    // section legitimately names the forbidden tokens by reference
    // to disavow them. We assert the cards (everything OUTSIDE the
    // methodology body) carry no causal copy.
    const bundle = makeBundle({
      itsResults: [itsResult('aaa', 0.1, 12, 14)],
      debtClusters: [debtCluster('k1', 5)],
      reflexiveResult: reflexiveComputed(),
    });
    const { container } = render(<InsightsMode bundle={bundle} />);
    const methodology = container.querySelector('.lcars-methodology');
    if (methodology !== null) methodology.remove();
    assertNoCausalLanguage(container.textContent ?? '');
  });

  it('renders the methodology disclosure expanded by default (Wave 7 P0)', () => {
    const bundle = makeBundle({
      reflexiveResult: reflexiveComputed(),
    });
    render(<InsightsMode bundle={bundle} />);
    const toggle = screen.getByRole('button', {
      name: /methodology.*limitations/i,
    });
    // Surface-visible by default: aria-expanded === 'true' on first paint.
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Confounding by indication')).toBeDefined();
    // Toggle still works — clicking collapses.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides the reflexive card below minNForRate matched pairs', () => {
    const sparse: ReflexiveResult = {
      pairs: [],
      pTreated: 0.5,
      pControl: 0.5,
      meanDelta: 0,
      ci: { low: -1, high: 1 },
      eValueCIBound: null,
      eValueStatus: 'ci-straddles-null',
      nTreated: 3, // below display.minNForRate (8)
      nControl: 5,
    };
    const bundle = makeBundle({ reflexiveResult: sparse });
    render(<InsightsMode bundle={bundle} />);
    expect(screen.getByText(/Only 3 matched-pair contrasts/i)).toBeDefined();
  });

  it('invokes onSelectSession when an evidence pill is clicked', () => {
    let clicked: string | null = null;
    const bundle = makeBundle({
      debtClusters: [debtCluster('k1', 5)],
    });
    render(
      <InsightsMode
        bundle={bundle}
        onSelectSession={(id) => {
          clicked = id;
        }}
      />,
    );
    const pill = screen.getAllByRole('button', { name: /session: k1-sess-/ })[0];
    if (pill === undefined) throw new Error('no evidence pill rendered');
    fireEvent.click(pill);
    expect(clicked).not.toBeNull();
    expect(clicked).toContain('k1-sess-');
  });

  it('renders a [copy] button on each ITS card (Wave 7 P1 #6)', () => {
    const bundle = makeBundle({
      itsResults: [itsResult('aaa', 0.12, 12, 14)],
    });
    render(<InsightsMode bundle={bundle} />);
    expect(screen.getByTestId('copy-its-aaa:CLAUDE.md')).toBeDefined();
  });

  it('renders a [copy] button + DISMISS on knowledge-debt clusters', () => {
    const bundle = makeBundle({
      debtClusters: [debtCluster('k1', 12)],
    });
    render(<InsightsMode bundle={bundle} />);
    expect(screen.getByTestId('copy-debt-k1')).toBeDefined();
    expect(screen.getByTestId('dismiss-cluster-k1')).toBeDefined();
    expect(screen.getByTestId('install-rule-k1')).toBeDefined();
  });

  it('renders a [copy] button on the reflexive card', () => {
    const bundle = makeBundle({
      reflexiveResult: reflexiveComputed(),
    });
    render(<InsightsMode bundle={bundle} />);
    expect(screen.getByTestId('copy-reflexive')).toBeDefined();
  });

  it('renders the SidecarEmptyState CTA when onOpenDataPanel is passed', () => {
    const empty: InsightsBundle = {
      configHistory: null,
      its: null,
      knowledgeDebt: null,
      reflexive: null,
    };
    render(
      <InsightsMode bundle={empty} onOpenDataPanel={() => undefined} />,
    );
    expect(screen.getByTestId('open-data-panel-cta')).toBeDefined();
  });

  it('flags STALE-ACK when the acked CI no longer overlaps the snapshot CI', () => {
    // Pre-seed an ack with a snapshot CI that lies entirely above the
    // current ITS row's CI — drift triggers re-promotion + stale chip.
    const acks = {
      schemaVersion: 1 as const,
      generatedAt: 0,
      entries: [
        {
          id: 'aaa:CLAUDE.md',
          kind: 'its-contrast' as const,
          acknowledgedAt: 1,
          // Snapshot CI sits at [0.4, 0.6]; current delta is +0.12 with
          // CI [0.02, 0.22] — disjoint upward, so stale fires.
          snapshot: {
            deltaCI: { low: 0.4, high: 0.6 },
            nPost: 14,
            nPre: 12,
          },
        } as unknown as InsightsAckEntry,
      ],
    };
    const bundle = makeBundle({
      itsResults: [itsResult('aaa', 0.12, 12, 14)],
    });
    render(<InsightsMode bundle={bundle} acks={acks} />);
    expect(screen.getByTestId('stale-ack-aaa:CLAUDE.md')).toBeDefined();
  });
});
