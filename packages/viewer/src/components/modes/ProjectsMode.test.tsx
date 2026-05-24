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
});
