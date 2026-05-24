import { describe, it, expect } from 'vitest';
import type {
  CompositeOutcome,
  Decision,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import {
  POST_MORTEM_PERCENTILE_FLOOR,
  buildExportManifest,
  buildPostMortemFrontmatter,
  buildSummaryPrompt,
  checkEligibility,
  generatePostMortem,
  renderPostMortemBody,
  serializeFrontmatter,
} from './index.js';

/**
 * Synthetic top-quintile session. The composite + decision shapes
 * mirror the real schema so any drift in the on-disk types breaks
 * this test loudly. Body assertions check STRUCTURE (frontmatter
 * keys, table headers, section labels) — never LLM-summary text.
 */
function fixtureSession(overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id: 'sess-abc-123',
    source: 'cli-direct',
    rawSessionId: 'sess-abc-123',
    startedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
    updatedAt: Date.UTC(2026, 0, 15, 12, 0, 0),
    durationMs: 90 * 60_000,
    title: 'Refactor the cloud-mapping kernel',
    titleSource: 'ai-title',
    preview: null,
    userTurns: 8,
    model: 'claude-opus-4-7',
    cwdKind: 'host',
    project: 'chat-arch',
    totalCostUsd: 1.42,
    ...overrides,
  };
}

function fixtureComposite(overrides: Partial<CompositeOutcome> = {}): CompositeOutcome {
  return {
    sessionId: 'sess-abc-123',
    source: 'cli-direct',
    testPass: true,
    buildPass: true,
    prLand: 'merged',
    noRework: true,
    affirmation: true,
    score: 0.87,
    linearLogit: 1.9,
    binary: 'good',
    weightsHash: 'abc1234567890def',
    ...overrides,
  };
}

function fixtureDecision(overrides: Partial<Decision['classification']> = {}): Decision {
  return {
    candidate: {
      id: 'dec-1',
      sessionId: 'sess-abc-123',
      userTurnIndex: 3,
      kind: 'explicit-go-with',
      span: { phrase: "let's go with the kernel split", startOffset: 0 },
      surroundingContext: '...',
    },
    classification: {
      kind: 'explicit-go-with',
      distilledDecision: 'split cloud-mapping into kernel + I/O layer',
      chosen: ['kernel + I/O split'],
      rejected: ['monolithic mapping'],
      confidence: 0.86,
      actionable: true,
      ...overrides,
    } as Decision['classification'],
    outcomeRef: null,
  };
}

describe('checkEligibility', () => {
  it('admits top-quintile sessions with actionable decisions and a project', () => {
    const r = checkEligibility({
      session: fixtureSession(),
      composite: fixtureComposite(),
      decisions: [fixtureDecision()],
      outcomePercentile: 0.92,
    });
    expect(r.eligible).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it('rejects below the percentile floor', () => {
    const r = checkEligibility({
      session: fixtureSession(),
      composite: fixtureComposite(),
      decisions: [fixtureDecision()],
      outcomePercentile: 0.6,
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons.some(s => s.includes('percentile'))).toBe(true);
  });

  it('rejects when no actionable decision is present', () => {
    const nonActionable = fixtureDecision({ actionable: false });
    const r = checkEligibility({
      session: fixtureSession(),
      composite: fixtureComposite(),
      decisions: [nonActionable],
      outcomePercentile: 0.95,
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('no actionable decisions');
  });

  it('rejects when the session has no project scope', () => {
    const s = fixtureSession();
    // exactOptionalPropertyTypes prevents `project: undefined`; reassign via delete-cast.
    const session: UnifiedSessionEntry = { ...s };
    delete (session as { project?: string }).project;
    const r = checkEligibility({
      session,
      composite: fixtureComposite(),
      decisions: [fixtureDecision()],
      outcomePercentile: 0.95,
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('no single-project scope');
  });

  it('floor is at 0.8 (top quintile)', () => {
    expect(POST_MORTEM_PERCENTILE_FLOOR).toBe(0.8);
  });
});

describe('generatePostMortem — structure', () => {
  const baseInputs = {
    session: fixtureSession(),
    composite: fixtureComposite(),
    decisions: [fixtureDecision()],
    outcomePercentile: 0.91,
    now: Date.UTC(2026, 4, 19, 12, 0, 0),
    runLlm: () => 'STUB LLM SUMMARY — not asserted on.',
  };

  it('returns a path under exports/post-mortems/<sessionId>.md', () => {
    const doc = generatePostMortem(baseInputs);
    expect(doc.path).toBe('exports/post-mortems/sess-abc-123.md');
  });

  it('emits YAML frontmatter with the required keys', () => {
    const doc = generatePostMortem(baseInputs);
    // Body starts with a `---` fence; pull the frontmatter block out.
    const fenceEnd = doc.body.indexOf('\n---\n', 4);
    expect(fenceEnd).toBeGreaterThan(0);
    const fm = doc.body.slice(0, fenceEnd + 5);
    expect(fm).toMatch(/^---\n/);
    expect(fm).toMatch(/\ntags: \[post-mortem\]\n/);
    expect(fm).toMatch(/\naliases: \[\]\n/);
    // ISO datetime contains colons → YAML-quotes it. Obsidian parses fine.
    expect(fm).toMatch(/\ncreated: "2026-05-19T12:00:00\.000Z"\n/);
    expect(fm).toMatch(/\nsession: sess-abc-123\n/);
    expect(fm).toMatch(/\noutcome-percentile: 0.91\n/);
    expect(fm).toMatch(/\ncomposite-score: 0.87\n/);
    expect(fm).toMatch(/\ncomposite-binary: good\n/);
    expect(fm).toMatch(/\nproject: chat-arch\n/);
  });

  it('renders a decisions table with one row per actionable decision', () => {
    const doc = generatePostMortem(baseInputs);
    expect(doc.body).toMatch(/## Decisions\n/);
    expect(doc.body).toMatch(/\| Kind \| Chosen \| Rejected \| Confidence \|/);
    expect(doc.body).toMatch(/\| explicit-go-with \| kernel \+ I\/O split \| monolithic mapping \| 0\.86 \|/);
  });

  it('renders the outcome callout block', () => {
    const doc = generatePostMortem(baseInputs);
    expect(doc.body).toMatch(/> \[!summary\] Outcome\n/);
    expect(doc.body).toMatch(/Composite score: \*\*0\.870\*\*/);
    expect(doc.body).toMatch(/Percentile: \*\*91th\*\*/);
  });

  it('includes a Review feedback section when reviewSignals supplied', () => {
    const doc = generatePostMortem({
      ...baseInputs,
      reviewSignals: {
        prNumber: 42,
        reviewSubstantiveCount: 3,
        reviewNitCount: 5,
        reviewIterations: 2,
        timeToMergeMs: 90 * 60_000,
      },
    });
    expect(doc.body).toMatch(/## Review feedback\n/);
    expect(doc.body).toMatch(/- PR: #42/);
    expect(doc.body).toMatch(/- Substantive comments: 3/);
    expect(doc.body).toMatch(/- Time-to-merge: 1h 30m/);
    expect(doc.frontmatter['pr-number']).toBe(42);
  });

  it('omits Review feedback section when reviewSignals absent', () => {
    const doc = generatePostMortem(baseInputs);
    expect(doc.body).not.toMatch(/## Review feedback/);
  });

  it('degrades gracefully when the LLM call throws', () => {
    const doc = generatePostMortem({
      ...baseInputs,
      runLlm: () => { throw new Error('claude offline'); },
    });
    expect(doc.body).toMatch(/_LLM summary unavailable: claude offline\._/);
  });

  it('throws on an ineligible session (caller must filter)', () => {
    expect(() =>
      generatePostMortem({ ...baseInputs, outcomePercentile: 0.5 }),
    ).toThrow(/ineligible/);
  });
});

describe('buildSummaryPrompt', () => {
  it('does NOT include any transcript-text snippets (structure-only prompt)', () => {
    const prompt = buildSummaryPrompt({
      session: fixtureSession(),
      composite: fixtureComposite(),
      decisions: [fixtureDecision()],
      outcomePercentile: 0.91,
    });
    // Prompt feeds the LLM structured fields; the full transcript text
    // is NEVER concatenated. Guard that contract: the candidate's
    // surroundingContext placeholder should not appear in the prompt.
    expect(prompt).not.toContain('surroundingContext');
    expect(prompt).toContain('split cloud-mapping into kernel + I/O layer');
    expect(prompt).toContain('Composite score: 0.870');
  });
});

describe('buildPostMortemFrontmatter', () => {
  it('quotes outcome-percentile to 2 dp for stable YAML', () => {
    const fm = buildPostMortemFrontmatter({
      session: fixtureSession(),
      composite: fixtureComposite(),
      decisions: [fixtureDecision()],
      outcomePercentile: 0.9166666,
      now: Date.UTC(2026, 0, 1),
    });
    expect(fm['outcome-percentile']).toBe(0.92);
  });
});

describe('renderPostMortemBody — empty-decisions branch', () => {
  it('renders an italic placeholder when no actionable decisions are present', () => {
    // Eligibility filters this out, but render is pure-function — exercise the branch directly.
    const body = renderPostMortemBody(
      {
        session: fixtureSession(),
        composite: fixtureComposite(),
        decisions: [],
        outcomePercentile: 0.91,
      },
      'summary',
    );
    expect(body).toMatch(/_No actionable decisions extracted\._/);
  });
});

describe('serializeFrontmatter + buildExportManifest — interop smoke', () => {
  it('frontmatter serialization round-trips the post-mortem object', () => {
    const fm = buildPostMortemFrontmatter({
      session: fixtureSession(),
      composite: fixtureComposite(),
      decisions: [fixtureDecision()],
      outcomePercentile: 0.91,
      now: Date.UTC(2026, 0, 1),
    });
    const out = serializeFrontmatter(fm);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.trim().endsWith('---')).toBe(true);
  });

  it('export manifest sorts entries by relativePath', () => {
    const m = buildExportManifest(
      [
        { id: 'b', kind: 'post-mortem', relativePath: 'exports/post-mortems/b.md', generatedAt: '2026-01-01T00:00:00Z' },
        { id: 'a', kind: 'post-mortem', relativePath: 'exports/post-mortems/a.md', generatedAt: '2026-01-01T00:00:00Z' },
      ],
      Date.UTC(2026, 0, 1),
    );
    expect(m.entries.map(e => e.id)).toEqual(['a', 'b']);
    expect(m.manifestVersion).toBe(1);
  });
});
