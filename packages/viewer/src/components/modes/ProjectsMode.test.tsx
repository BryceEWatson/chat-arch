// Tests for the Phase Rev3-D D3 narrative audit affordance in
// ProjectsMode's detail view. Verifies the dismiss button posts to
// the entity-states endpoint, the audit row renders dismissal counts
// using the production `narrativeSaturation` helper, and the shelved
// regime hides the DISMISS button (D4 will add the corresponding
// "show shelved" toggle that filters the card out entirely).
//
// The component-mode tests in this repo (InsightsMode.test.tsx,
// DecisionsMode.test.tsx, etc.) all use React Testing Library +
// vitest with global-fetch stubbing. We follow the same shape so the
// audit affordance integrates with the existing test infrastructure.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import type {
  UnifiedSessionEntry,
  Project,
  Narrative,
} from '@chat-arch/schema';
import { THRESHOLDS } from '@chat-arch/analysis';
import { ProjectsMode } from './ProjectsMode.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function project(id: string, narrativeIds: readonly string[]): Project {
  return {
    id,
    displayName: `Project ${id}`,
    discoveredAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-02T00:00:00Z',
    sentiment: 'positive',
    source: 'cli-cwd',
    sessionIds: [],
    topicIds: [],
    narrativeIds,
    digestPath: null,
  };
}

function narrative(
  id: string,
  evidenceCount: number,
  overrides: Partial<Narrative> = {},
): Narrative {
  return {
    id,
    projectId: 'p1',
    sentiment: 'positive',
    actionType: 'encode-as-pattern',
    title: `Title for ${id}`,
    body: `Body for ${id}`,
    generatedAt: '2026-01-02T00:00:00Z',
    evidence: Array.from({ length: evidenceCount }, (_, i) => ({
      sessionId: `${id}-s${i}`,
      sessionSource: 'cli-direct',
      excerpt: `excerpt ${i}`,
    })),
    schemaVersion: 1,
    ...overrides,
  };
}

function session(id: string): UnifiedSessionEntry {
  return {
    id,
    title: `Session ${id}`,
    rawSessionId: id,
    source: 'cli-direct',
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    durationMs: 0,
    workflow: { kind: 'unknown' },
    messageCount: 1,
    sentiment: 'neutral',
    titleSource: 'first-prompt',
  };
}

interface FetchScript {
  // Map of (URL-suffix substring) → response body.
  readonly responses: ReadonlyMap<string, unknown>;
  readonly recordedPosts: { url: string; body: unknown }[];
}

function installFetchStub(script: FetchScript): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        let body: unknown = init?.body;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch {
            // leave raw
          }
        }
        script.recordedPosts.push({ url, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => '',
        } as Response;
      }
      for (const [suffix, payload] of script.responses) {
        if (url.includes(suffix)) {
          return {
            ok: true,
            status: 200,
            json: async () => payload,
            text: async () => JSON.stringify(payload),
          } as Response;
        }
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as Response;
    }),
  );
}

function renderDetail(
  options: {
    narratives: readonly Narrative[];
    entityStates?: readonly {
      entityKind: string;
      entityId: string;
      state: string;
      updatedAt: number;
      sizeAtState: number;
      dismissalCount?: number;
    }[];
  } & { fetchScript?: FetchScript },
): FetchScript {
  const script: FetchScript = options.fetchScript ?? {
    responses: new Map<string, unknown>([
      [
        '/api/entity-states',
        {
          ok: true,
          available: true,
          entries: options.entityStates ?? [],
        },
      ],
    ]),
    recordedPosts: [],
  };
  installFetchStub(script);

  const proj = project(
    'p1',
    options.narratives.map((n) => n.id),
  );
  render(
    <ProjectsMode
      projects={[proj]}
      topics={[]}
      narratives={options.narratives}
      sessions={[session('p1-s0')]}
      selectedProjectId="p1"
      onSelectProject={() => {}}
      onSelectSession={() => {}}
      dataDirBaseUrl="/test-data"
    />,
  );
  return script;
}

describe('ProjectsMode narrative audit (Rev3-D D3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the audit row with default counts when no ledger entry exists', async () => {
    renderDetail({ narratives: [narrative('n1', 3)] });
    // Default state: 0/cap dismissals + no re-emerges-at line + a
    // DISMISS button visible.
    const cap = THRESHOLDS.narrativeRung.maxDismissals;
    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`0/${cap} dismissals`)),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/re-emerges at/i)).toBeNull();
    expect(screen.getByRole('button', { name: /dismiss this narrative/i })).toBeTruthy();
  });

  it('shows the re-promotion threshold when state is DISMISSED', async () => {
    renderDetail({
      narratives: [narrative('n1', 5)],
      entityStates: [
        {
          entityKind: 'narrative',
          entityId: 'n1',
          state: 'DISMISSED',
          updatedAt: 1_700_000_000_000,
          sizeAtState: 3,
          dismissalCount: 1,
        },
      ],
    });
    const cap = THRESHOLDS.narrativeRung.maxDismissals;
    // After 1 dismissal: base × decay (default 2 × 2 = 4).
    // sizeAtState=3 → re-emerges at ≥ 3 × 4 = 12 evidence.
    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`1/${cap} dismissals`)),
      ).toBeTruthy();
    });
    expect(screen.getByText(/re-emerges at ≥12 evidence/i)).toBeTruthy();
    // While DISMISSED, the DISMISS button doesn't render — re-promotion
    // happens via evidence growth, not a re-click.
    expect(
      screen.queryByRole('button', { name: /dismiss this narrative/i }),
    ).toBeNull();
  });

  it('hides the DISMISS button and shows SHELVED in the shelved regime', async () => {
    const cap = THRESHOLDS.narrativeRung.maxDismissals;
    renderDetail({
      narratives: [narrative('n1', 2)],
      entityStates: [
        {
          entityKind: 'narrative',
          entityId: 'n1',
          state: 'DISMISSED',
          updatedAt: 1_700_000_000_000,
          sizeAtState: 2,
          // At-cap dismissals → narrativeSaturation returns shelved.
          dismissalCount: cap,
        },
      ],
    });
    // D4 hides shelved cards by default — flip the toggle to assert
    // the audit-row contents that show on reveal.
    await waitFor(() => {
      expect(
        screen.getByLabelText(/show 1 shelved narratives/i),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText(/show 1 shelved narratives/i));
    await waitFor(() => {
      expect(screen.getByText(/SHELVED/)).toBeTruthy();
    });
    expect(
      screen.queryByRole('button', { name: /dismiss this narrative/i }),
    ).toBeNull();
  });

  it('POSTs DISMISSED + current evidence count when DISMISS is clicked', async () => {
    const script = renderDetail({ narratives: [narrative('n1', 4)] });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /dismiss this narrative/i }),
      ).toBeTruthy();
    });
    const button = screen.getByRole('button', {
      name: /dismiss this narrative/i,
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(script.recordedPosts.length).toBeGreaterThan(0);
    });
    const post = script.recordedPosts[0]!;
    expect(post.url).toContain('/api/entity-states');
    expect(post.body).toMatchObject({
      entityKind: 'narrative',
      entityId: 'n1',
      state: 'DISMISSED',
      sizeAtState: 4,
    });
  });

  it('bumps the local dismissalCount optimistically on a successful dismiss', async () => {
    const script = renderDetail({ narratives: [narrative('n1', 4)] });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /dismiss this narrative/i }),
      ).toBeTruthy();
    });
    const button = screen.getByRole('button', {
      name: /dismiss this narrative/i,
    });
    fireEvent.click(button);
    const cap = THRESHOLDS.narrativeRung.maxDismissals;
    await waitFor(() => {
      // After the optimistic local update we should see 1/cap.
      expect(
        screen.getByText(new RegExp(`1/${cap} dismissals`)),
      ).toBeTruthy();
    });
    // And the re-emerges-at line appears (state is now DISMISSED locally).
    expect(screen.getByText(/re-emerges at/i)).toBeTruthy();
    expect(script.recordedPosts.length).toBe(1);
  });

  it('prefers the server-returned dismissalCount over the local approximation', async () => {
    // Reviewer finding (D3 iter-1): the C4 SDK is authoritative — its
    // `upsertEntityState` runs the read-old + compute-counter + write
    // sequence inside a single BEGIN IMMEDIATE, so its `dismissalCount`
    // reflects any prior state we may not have known about (sibling
    // tab dismissed first, legacy migrator seeded a count, etc.).
    // This test pins that the client honors `r.entry.dismissalCount`
    // when present rather than blindly applying the local
    // PENDING→DISMISSED-bumps-by-one heuristic.
    const cap = THRESHOLDS.narrativeRung.maxDismissals;
    // Override the POST response to return an entry with
    // dismissalCount=2 — the local heuristic would compute 1 (no
    // prior entry → 0 + 1), so the assertion below proves the
    // server's value wins.
    const script: FetchScript = {
      responses: new Map<string, unknown>([
        [
          '/api/entity-states',
          { ok: true, available: true, entries: [] },
        ],
      ]),
      recordedPosts: [],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        let body: unknown = init?.body;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch {
            /* leave raw */
          }
        }
        script.recordedPosts.push({ url, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            entry: {
              entityKind: 'narrative',
              entityId: 'n1',
              state: 'DISMISSED',
              updatedAt: 1000,
              sizeAtState: 4,
              dismissalCount: 2, // server's canonical count
            },
          }),
          text: async () => '',
        } as Response;
      }
      // GET: empty ledger.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, available: true, entries: [] }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch);

    const proj = project('p1', ['n1']);
    render(
      <ProjectsMode
        projects={[proj]}
        topics={[]}
        narratives={[narrative('n1', 4)]}
        sessions={[session('p1-s0')]}
        selectedProjectId="p1"
        onSelectProject={() => {}}
        onSelectSession={() => {}}
        dataDirBaseUrl="/test-data"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /dismiss this narrative/i }),
      ).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole('button', { name: /dismiss this narrative/i }),
    );
    await waitFor(() => {
      // The server returned dismissalCount=2 — the UI must reflect THAT,
      // not the local heuristic's 1.
      expect(
        screen.getByText(new RegExp(`2/${cap} dismissals`)),
      ).toBeTruthy();
    });
  });
});

describe('ProjectsMode show-shelved toggle (Rev3-D D4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('hides shelved narratives by default and surfaces a toggle showing the count', async () => {
    const cap = THRESHOLDS.narrativeRung.maxDismissals;
    renderDetail({
      narratives: [narrative('n-active', 3), narrative('n-shelved', 3)],
      entityStates: [
        {
          entityKind: 'narrative',
          entityId: 'n-shelved',
          state: 'DISMISSED',
          updatedAt: 1_700_000_000_000,
          sizeAtState: 3,
          dismissalCount: cap,
        },
      ],
    });
    // Active narrative renders; shelved does NOT.
    await waitFor(() => {
      expect(screen.getByText(/Title for n-active/)).toBeTruthy();
    });
    expect(screen.queryByText(/Title for n-shelved/)).toBeNull();
    // The toggle is present with the shelved count.
    expect(
      screen.getByLabelText(/show 1 shelved narratives/i),
    ).toBeTruthy();
  });

  it('reveals shelved narratives when the toggle is flipped on', async () => {
    const cap = THRESHOLDS.narrativeRung.maxDismissals;
    renderDetail({
      narratives: [narrative('n-shelved', 3)],
      entityStates: [
        {
          entityKind: 'narrative',
          entityId: 'n-shelved',
          state: 'DISMISSED',
          updatedAt: 1_700_000_000_000,
          sizeAtState: 3,
          dismissalCount: cap,
        },
      ],
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText(/show 1 shelved narratives/i),
      ).toBeTruthy();
    });
    // Before flip: empty-state message names the shelved scope.
    expect(screen.getByText(/All 1 narrative is shelved/i)).toBeTruthy();
    expect(screen.queryByText(/Title for n-shelved/)).toBeNull();
    // Flip the toggle.
    fireEvent.click(screen.getByLabelText(/show 1 shelved narratives/i));
    await waitFor(() => {
      expect(screen.getByText(/Title for n-shelved/)).toBeTruthy();
    });
    // The toggle's aria-label flips to "hide ..." now that it's checked.
    expect(screen.getByLabelText(/hide 1 shelved narratives/i)).toBeTruthy();
  });

  it('omits the toggle entirely when no narratives are shelved', async () => {
    renderDetail({ narratives: [narrative('n1', 3)] });
    await waitFor(() => {
      expect(screen.getByText(/Title for n1/)).toBeTruthy();
    });
    expect(screen.queryByLabelText(/shelved narratives/i)).toBeNull();
  });
});

describe('ProjectsMode falsifier-override checkbox (Rev3-E E3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function positive(id: string): Narrative {
    return {
      id,
      projectId: 'p1',
      sentiment: 'positive',
      actionType: 'encode-as-pattern',
      title: `Title for ${id}`,
      body: `Body for ${id}`,
      generatedAt: '2026-01-02T00:00:00Z',
      evidence: [],
      schemaVersion: 1,
    };
  }

  function negative(id: string): Narrative {
    return { ...positive(id), sentiment: 'negative', actionType: 'corrective-prompt' };
  }

  it('renders the override checkbox only for positive narratives (encode path)', async () => {
    renderDetail({ narratives: [positive('n-pos'), negative('n-neg')] });
    await waitFor(() => {
      expect(screen.getByText(/Title for n-pos/)).toBeTruthy();
    });
    // Two narratives total, but only the positive one renders the
    // skip-falsifier checkbox.
    const checkboxes = screen.queryAllByLabelText(
      /skip falsifier verification when encoding/i,
    );
    expect(checkboxes.length).toBe(1);
  });

  it('checkbox is unchecked by default (safe falsifier-gating default)', async () => {
    renderDetail({ narratives: [positive('n1')] });
    await waitFor(() => {
      expect(
        screen.getByLabelText(/skip falsifier verification when encoding/i),
      ).toBeTruthy();
    });
    const checkbox = screen.getByLabelText(
      /skip falsifier verification when encoding/i,
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('flipping the checkbox toggles its state for the next encode click', async () => {
    renderDetail({ narratives: [positive('n1')] });
    await waitFor(() => {
      expect(
        screen.getByLabelText(/skip falsifier verification when encoding/i),
      ).toBeTruthy();
    });
    const checkbox = screen.getByLabelText(
      /skip falsifier verification when encoding/i,
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });
});

describe('ProjectsMode cap-K integration gate (Rev3-D D5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Phase Rev3-D gate: a previously-dismissed Narrative re-enters the
   * feed only after evidence growth exceeds the multiplier; capped
   * re-promotion attempts visible in the audit table. This test
   * drives the saturation kernel from end-state seeded ledger entries
   * (mirroring what the user would observe after cap-K dismissals
   * accumulated) and asserts the integrated viewer behavior:
   *
   *   - At dismissalCount=cap−1, the audit row shows the highest
   *     pre-cap multiplier bar (×2^(cap-1) baseline ≈ ×8 with
   *     defaults) and the card stays in the active pile.
   *   - At dismissalCount=cap, the card hides from the active pile,
   *     the show-shelved toggle reveals the SHELVED sentinel, and the
   *     DISMISS button is no longer rendered (the cap is enforced).
   *
   * This walks the same gate the SDK-layer C5 round-trip test (PR #74)
   * walks at the data layer — extending it through the entity-states
   * SDK → endpoint → viewer composition.
   */
  it('walks dismissalCount from cap−1 to cap and asserts the shelved transition', async () => {
    const cap = THRESHOLDS.narrativeRung.maxDismissals;
    const base = THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier;
    const decay = THRESHOLDS.narrativeRung.dismissDecay;

    // Phase 1 — cap-1 dismissals: still re-promotable. Audit row
    // shows the highest pre-cap multiplier bar.
    cleanup();
    renderDetail({
      narratives: [narrative('n-cap-minus-1', 3)],
      entityStates: [
        {
          entityKind: 'narrative',
          entityId: 'n-cap-minus-1',
          state: 'DISMISSED',
          updatedAt: 1_700_000_000_000,
          sizeAtState: 3,
          dismissalCount: cap - 1,
        },
      ],
    });
    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`${cap - 1}/${cap} dismissals`)),
      ).toBeTruthy();
    });
    // sizeAtState=3, multiplier = base × decay^(cap−1).
    const preCapMultiplier = base * Math.pow(decay, cap - 1);
    const preCapThreshold = Math.ceil(3 * preCapMultiplier);
    expect(
      screen.getByText(new RegExp(`re-emerges at ≥${preCapThreshold} evidence`)),
    ).toBeTruthy();
    // SHELVED sentinel must NOT appear.
    expect(screen.queryByText(/SHELVED/)).toBeNull();

    // Phase 2 — at the cap: shelved + hidden until the toggle reveals it.
    cleanup();
    renderDetail({
      narratives: [narrative('n-at-cap', 3)],
      entityStates: [
        {
          entityKind: 'narrative',
          entityId: 'n-at-cap',
          state: 'DISMISSED',
          updatedAt: 1_700_000_000_000,
          sizeAtState: 3,
          dismissalCount: cap,
        },
      ],
    });
    // Default render: card hidden, toggle visible.
    await waitFor(() => {
      expect(
        screen.getByLabelText(/show 1 shelved narratives/i),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/Title for n-at-cap/)).toBeNull();

    // Flip the toggle — SHELVED visible, DISMISS not rendered (cap enforced).
    fireEvent.click(screen.getByLabelText(/show 1 shelved narratives/i));
    await waitFor(() => {
      expect(screen.getByText(/SHELVED/)).toBeTruthy();
    });
    expect(
      screen.queryByRole('button', { name: /dismiss this narrative/i }),
    ).toBeNull();
  });
});

// ---- V1 narrative-mining two-tier UI (spec §UI surface) ----
// Fixture has both heuristic and llm-derived narratives. Primary cards
// = LLM; collapsed disclosure = heuristic. Tier badges only render on
// LLM rows (V1 cap clamps LLM rows to ≤ 2, so no TIER-3 ever).

describe('ProjectsMode V1 narrative-mining — two-tier UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function llmNarrative(
    id: string,
    overrides: Partial<Narrative> = {},
  ): Narrative {
    return {
      ...narrative(id, 2),
      schemaVersion: 2,
      attributedTo: 'llm-derived',
      confidence: 0.667,
      supportingCount: 6,
      contradictingCount: 0,
      provenance: {
        intent: `intent-${id}`,
        observation: `observation-${id}`,
        inference: `inference-${id}`,
      },
      verifiedAt: null,
      ...overrides,
    };
  }

  function heuristicNarrative(
    id: string,
    overrides: Partial<Narrative> = {},
  ): Narrative {
    return {
      ...narrative(id, 2),
      schemaVersion: 1,
      attributedTo: 'deterministic',
      ...overrides,
    };
  }

  it('renders LLM-derived cards as primary, heuristic in collapsed disclosure', async () => {
    const llmA = llmNarrative('llm-a', { title: 'LLM A pattern', confidence: 0.8 });
    const llmB = llmNarrative('llm-b', { title: 'LLM B pattern', confidence: 0.5 });
    const llmC = llmNarrative('llm-c', { title: 'LLM C pattern', confidence: 0.6 });
    const heurA = heuristicNarrative('heur-a', { title: 'Raw cluster positive' });
    const heurB = heuristicNarrative('heur-b', { title: 'Raw cluster negative' });
    renderDetail({ narratives: [llmA, llmB, llmC, heurA, heurB] });
    // All 3 LLM card titles render (primary slot).
    for (const t of ['LLM A pattern', 'LLM B pattern', 'LLM C pattern']) {
      expect(await screen.findByText(t)).toBeTruthy();
    }
    // Heuristic disclosure summary renders ("Raw sentiment clusters
    // (deterministic, 2)").
    expect(
      screen.getByText(/raw sentiment clusters \(deterministic, 2\)/i),
    ).toBeTruthy();
    // Heuristic titles render in the DOM (the <details> element keeps
    // children mounted; only the visual collapse is browser-rendered).
    expect(screen.getByText('Raw cluster positive')).toBeTruthy();
    expect(screen.getByText('Raw cluster negative')).toBeTruthy();
  });

  it('LLM rows render a tier badge (TIER-1 or TIER-2; TIER-3 NEVER under V1 cap)', async () => {
    // Force a confidence that WOULD reach tier-3 absent the V1 cap
    // (supporting=6, contradicting=1, confidence ~0.667). The cap
    // clamps to tier-2 — assert no TIER-3 badge surfaces.
    const wouldBeTier3 = llmNarrative('llm-tier3-attempt', {
      confidence: 0.667,
      supportingCount: 6,
      contradictingCount: 1,
    });
    renderDetail({ narratives: [wouldBeTier3] });
    await screen.findByText('Title for llm-tier3-attempt');
    expect(screen.queryByText(/TIER-3/)).toBeNull();
    expect(screen.getByText(/TIER-2/)).toBeTruthy();
  });

  it('heuristic rows do NOT show a tier badge', async () => {
    renderDetail({ narratives: [heuristicNarrative('heur-only')] });
    await screen.findByText(/raw sentiment clusters/i);
    expect(screen.queryByText(/TIER-[123]/)).toBeNull();
  });

  it('legacy row missing attributedTo defaults to heuristic family (collapsed)', async () => {
    // Build a narrative with no attributedTo field at all.
    const legacy: Narrative = {
      id: 'legacy-no-attr',
      projectId: 'p1',
      sentiment: 'positive',
      actionType: 'encode-as-pattern',
      title: 'Legacy cluster',
      body: 'b',
      generatedAt: '2026-01-02T00:00:00Z',
      evidence: [{ sessionId: 'legacy-s0', excerpt: 'x' }],
      sessionIds: ['legacy-s0'],
      schemaVersion: 1,
    };
    renderDetail({ narratives: [legacy] });
    // The disclosure renders (heuristic family). Wait for entity-states
    // to settle.
    await waitFor(() => {
      expect(
        screen.getByText(/raw sentiment clusters \(deterministic, 1\)/i),
      ).toBeTruthy();
    });
  });

  it('renders a skip hint when the project has zero LLM rows AND a skip-row is present', async () => {
    const script: FetchScript = {
      responses: new Map<string, unknown>([
        [
          '/api/entity-states',
          { ok: true, available: true, entries: [] },
        ],
      ]),
      recordedPosts: [],
    };
    installFetchStub(script);
    const proj = project('p1', ['heur-only']);
    render(
      <ProjectsMode
        projects={[proj]}
        topics={[]}
        narratives={[heuristicNarrative('heur-only')]}
        narrativesSkipped={[
          {
            projectId: 'p1',
            status: 'synthesis-failed',
            reason: '2/3 narratives failed validateNarrative',
          },
        ]}
        sessions={[session('p1-s0')]}
        selectedProjectId="p1"
        onSelectProject={() => {}}
        onSelectSession={() => {}}
        dataDirBaseUrl="/test-data"
      />,
    );
    expect(
      await screen.findByText(
        /LLM found no durable narratives this run; raw clusters still available\./i,
      ),
    ).toBeTruthy();
  });

  it('does NOT render the skip hint when the project has LLM rows', async () => {
    const script: FetchScript = {
      responses: new Map<string, unknown>([
        [
          '/api/entity-states',
          { ok: true, available: true, entries: [] },
        ],
      ]),
      recordedPosts: [],
    };
    installFetchStub(script);
    const proj = project('p1', ['llm-a']);
    render(
      <ProjectsMode
        projects={[proj]}
        topics={[]}
        narratives={[llmNarrative('llm-a')]}
        narrativesSkipped={[
          {
            projectId: 'p1',
            status: 'synthesis-failed',
            reason: '...',
          },
        ]}
        sessions={[session('p1-s0')]}
        selectedProjectId="p1"
        onSelectProject={() => {}}
        onSelectSession={() => {}}
        dataDirBaseUrl="/test-data"
      />,
    );
    await screen.findByText('Title for llm-a');
    expect(
      screen.queryByText(/LLM found no durable narratives this run/i),
    ).toBeNull();
  });

  it('renders a REGEN NARRATIVES button when onRegenNarratives is provided', async () => {
    const script: FetchScript = {
      responses: new Map<string, unknown>([
        ['/api/entity-states', { ok: true, available: true, entries: [] }],
      ]),
      recordedPosts: [],
    };
    installFetchStub(script);
    const proj = project('p1', ['llm-a']);
    const onRegen = vi.fn();
    render(
      <ProjectsMode
        projects={[proj]}
        topics={[]}
        narratives={[llmNarrative('llm-a')]}
        sessions={[session('p1-s0')]}
        selectedProjectId="p1"
        onSelectProject={() => {}}
        onSelectSession={() => {}}
        dataDirBaseUrl="/test-data"
        onRegenNarratives={onRegen}
      />,
    );
    const btn = await screen.findByRole('button', {
      name: /regenerate narratives for/i,
    });
    fireEvent.click(btn);
    expect(onRegen).toHaveBeenCalledWith('p1');
  });

  it('does NOT render REGEN NARRATIVES when onRegenNarratives is undefined (hosted build)', async () => {
    renderDetail({ narratives: [llmNarrative('llm-a')] });
    await screen.findByText('Title for llm-a');
    expect(
      screen.queryByRole('button', { name: /regenerate narratives for/i }),
    ).toBeNull();
  });

  it('LLM card renders the provenance triple in a collapsed disclosure', async () => {
    renderDetail({
      narratives: [
        llmNarrative('llm-prov', {
          provenance: {
            intent: 'identify durable workflow patterns',
            observation: '12 of 14 sessions invoke /review-loop',
            inference: 'review-loop discipline is project-defining',
          },
        }),
      ],
    });
    await screen.findByText('Title for llm-prov');
    // The provenance summary text is rendered. The <details> element
    // keeps children mounted in the DOM regardless of open/closed
    // state, so we can assert the prose appears.
    expect(
      screen.getByText(/how this narrative was derived \(provenance\)/i),
    ).toBeTruthy();
    expect(
      screen.getByText('identify durable workflow patterns'),
    ).toBeTruthy();
    expect(
      screen.getByText('12 of 14 sessions invoke /review-loop'),
    ).toBeTruthy();
    expect(
      screen.getByText('review-loop discipline is project-defining'),
    ).toBeTruthy();
  });

  it('heuristic narrative without provenance does NOT render a provenance disclosure', async () => {
    renderDetail({ narratives: [heuristicNarrative('heur-only')] });
    await waitFor(() => {
      expect(
        screen.getByText(/raw sentiment clusters/i),
      ).toBeTruthy();
    });
    expect(
      screen.queryByText(/how this narrative was derived/i),
    ).toBeNull();
  });
});
