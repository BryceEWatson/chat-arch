import { describe, it, expect } from 'vitest';
import {
  DECISION_HEURISTIC_VERSION,
  DECISION_LFS,
  detectDecisions,
  runLabelingFunction,
  type DecisionTurnPair,
  type DecisionLabelingFunction,
} from './detectDecisions.js';

function turn(
  i: number,
  userText: string,
  precedingAssistantText: string | null = 'some assistant output',
): DecisionTurnPair {
  return { sessionId: 'sess1', userTurnIndex: i, userText, precedingAssistantText };
}

function findLf(name: string): DecisionLabelingFunction {
  const lf = DECISION_LFS.find((l) => l.name === name);
  if (lf === undefined) throw new Error(`LF not found: ${name}`);
  return lf;
}

describe('detectDecisions — recall (true positives must fire)', () => {
  describe('explicit-marker LF', () => {
    it('fires on "Decision:" colon-form', () => {
      const out = detectDecisions([
        turn(0, 'Decision: drop the staging server and deploy direct.'),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]?.kind).toBe('explicit-marker');
      expect(out[0]?.span.phrase.toLowerCase()).toContain('decision:');
    });

    it('fires on "we\'ve decided" and "I\'ve decided"', () => {
      const a = detectDecisions([turn(0, "We've decided to use ripgrep for now")]);
      expect(a).toHaveLength(1);
      expect(a[0]?.kind).toBe('explicit-marker');
      const b = detectDecisions([turn(0, "I've decided against the SDK approach")]);
      expect(b).toHaveLength(1);
      expect(b[0]?.kind).toBe('explicit-marker');
    });

    it('does NOT fire on bare "decide" without colon or auxiliary', () => {
      const hits = runLabelingFunction(
        findLf('explicit-marker'),
        "we'll decide tomorrow",
      );
      expect(hits).toEqual([]);
    });
  });

  describe('explicit-go-with LF', () => {
    it('fires on "let\'s go with X"', () => {
      const out = detectDecisions([turn(0, "let's go with option A then")]);
      expect(out.length).toBeGreaterThan(0);
      expect(out.some((d) => d.kind === 'explicit-go-with')).toBe(true);
    });

    it("fires on \"I'll use X\"", () => {
      const out = detectDecisions([turn(0, "I'll use the vitest fixture approach")]);
      expect(out.length).toBeGreaterThan(0);
      expect(out.some((d) => d.kind === 'explicit-go-with')).toBe(true);
    });

    it('fires on "we\'ll pick X"', () => {
      const out = detectDecisions([turn(0, "we'll pick the second one")]);
      expect(out.some((d) => d.kind === 'explicit-go-with')).toBe(true);
    });

    it('does NOT fire on "let\'s think about it" (no go/use/pick/choose)', () => {
      const hits = runLabelingFunction(
        findLf('explicit-go-with'),
        "let's think about this tomorrow",
      );
      expect(hits).toEqual([]);
    });
  });

  describe('instead-of LF', () => {
    it('fires on "X instead of Y"', () => {
      const out = detectDecisions([
        turn(0, 'use ripgrep instead of grep on this codebase'),
      ]);
      expect(out.some((d) => d.kind === 'instead-of')).toBe(true);
    });

    it('fires on "rather than"', () => {
      const out = detectDecisions([
        turn(0, "let's batch the updates rather than push one at a time"),
      ]);
      expect(out.some((d) => d.kind === 'instead-of')).toBe(true);
    });

    it('does NOT fire on text without instead/rather-than', () => {
      const hits = runLabelingFunction(
        findLf('instead-of'),
        'just keep going with what you have',
      );
      expect(hits).toEqual([]);
    });
  });

  describe('alternative-block LF', () => {
    it('fires when assistant lists "Option A:" and user replies with concurrence', () => {
      const assistantText =
        'Two approaches:\nOption A: in-place edit\nOption B: rebuild from scratch';
      const out = detectDecisions([
        turn(1, 'A', assistantText),
      ]);
      expect(out.some((d) => d.kind === 'alternative-block')).toBe(true);
    });

    it('fires when assistant uses numbered list and user replies "the first"', () => {
      const assistantText =
        'There are three options:\n1. cache the result\n2. recompute each time\n3. background prefetch';
      const out = detectDecisions([
        turn(1, 'the first', assistantText),
      ]);
      expect(out.some((d) => d.kind === 'alternative-block')).toBe(true);
    });

    it('fires on "yes do that" when assistant proposed alternatives', () => {
      const assistantText =
        'Approach one: refactor the parser. Approach two: bypass it entirely.';
      const out = detectDecisions([
        turn(1, 'yes do that', assistantText),
      ]);
      expect(out.some((d) => d.kind === 'alternative-block')).toBe(true);
    });

    it('does NOT fire when assistant turn lacks an options block (concurrence alone is not a decision)', () => {
      const out = detectDecisions([
        turn(1, 'A', 'I added the import you asked for.'),
      ]);
      expect(out.some((d) => d.kind === 'alternative-block')).toBe(false);
    });

    it('does NOT fire when the user reply is verbose (not a concurrence keyword)', () => {
      const assistantText =
        'Option A: in-place\nOption B: rebuild';
      const out = detectDecisions([
        turn(
          1,
          'I think Option A makes more sense for this case because of the perf implications.',
          assistantText,
        ),
      ]);
      // The mention of "Option A" is not at the message start; alternative-block
      // shouldn't fire. (Other LFs may still fire on the broader content.)
      expect(out.some((d) => d.kind === 'alternative-block')).toBe(false);
    });
  });

  describe('imperative-choice LF', () => {
    it('fires on "use X" at turn start', () => {
      const out = detectDecisions([turn(0, 'use vitest for the snapshot tests')]);
      expect(out.some((d) => d.kind === 'imperative-choice')).toBe(true);
    });

    it('fires on "pick X" at turn start', () => {
      const out = detectDecisions([turn(0, 'pick the smaller bundle option')]);
      expect(out.some((d) => d.kind === 'imperative-choice')).toBe(true);
    });

    it('fires on "go with X" at turn start', () => {
      const out = detectDecisions([turn(0, 'go with the prebuilt approach')]);
      expect(out.some((d) => d.kind === 'imperative-choice')).toBe(true);
    });

    it('fires on "choose X" at turn start', () => {
      const out = detectDecisions([turn(0, 'choose whichever has fewer deps')]);
      expect(out.some((d) => d.kind === 'imperative-choice')).toBe(true);
    });

    it('does NOT fire on "use" mid-sentence', () => {
      const hits = runLabelingFunction(
        findLf('imperative-choice'),
        "I'd like to use the new flag",
      );
      // Anchored to turn-start; "I'd" comes first.
      expect(hits).toEqual([]);
    });
  });
});

describe('detectDecisions — false positives admitted by design', () => {
  // Per the corrections precedent: surface-form patterns mis-fire on
  // edge cases. The kernel admits them; the LLM classification stage
  // marks them `actionable: false`. Lock the admission here so a
  // future engineer doesn't silently destroy recall.

  it('admits "use the same approach" — fires imperative-choice even though no real choice was made', () => {
    const out = detectDecisions([turn(0, 'use the same approach as before')]);
    expect(out.some((d) => d.kind === 'imperative-choice')).toBe(true);
    // Downstream LLM stage is expected to classify this as actionable: false.
  });
});

describe('detectDecisions — output shape', () => {
  it('emits one candidate per (turn, kind) hit', () => {
    // "Decision: use X instead of Y" should fire BOTH explicit-marker
    // and instead-of (and possibly explicit-go-with).
    const out = detectDecisions([
      turn(0, 'Decision: use vitest instead of jest going forward'),
    ]);
    const kinds = new Set(out.map((d) => d.kind));
    expect(kinds.has('explicit-marker')).toBe(true);
    expect(kinds.has('instead-of')).toBe(true);
  });

  it('truncates surroundingContext to 500 chars with ellipsis', () => {
    const long = 'Decision: ' + 'x'.repeat(600);
    const out = detectDecisions([turn(0, long)]);
    const explicit = out.find((d) => d.kind === 'explicit-marker');
    expect(explicit).toBeDefined();
    expect(explicit!.surroundingContext.length).toBe(500);
    expect(explicit!.surroundingContext.endsWith('…')).toBe(true);
  });

  it('produces stable ids for the same (sessionId, turnIndex, kind, phrase)', () => {
    const a = detectDecisions([turn(3, 'Decision: ship it')]);
    const b = detectDecisions([turn(3, 'Decision: ship it')]);
    expect(a[0]?.id).toBe(b[0]?.id);
  });

  it('records span.phrase and startOffset', () => {
    const out = detectDecisions([
      turn(0, "After thinking about it, let's go with vitest"),
    ]);
    const hit = out.find((d) => d.kind === 'explicit-go-with');
    expect(hit).toBeDefined();
    expect(hit!.span.phrase.length).toBeGreaterThan(0);
    expect(hit!.span.startOffset).toBeGreaterThan(0);
  });
});

describe('DECISION_LFS registry', () => {
  it('exposes all 5 LF families with unique names and known kinds', () => {
    const names = new Set<string>();
    for (const lf of DECISION_LFS) {
      expect(lf.name.length).toBeGreaterThan(0);
      expect(names.has(lf.name)).toBe(false);
      names.add(lf.name);
      expect(['full', 'prefix']).toContain(lf.scope);
      expect(['turn', 'pair']).toContain(lf.inspects);
      expect(lf.patterns.length).toBeGreaterThan(0);
    }
    const kinds = new Set(DECISION_LFS.map((lf) => lf.kind));
    expect(kinds.has('explicit-marker')).toBe(true);
    expect(kinds.has('explicit-go-with')).toBe(true);
    expect(kinds.has('instead-of')).toBe(true);
    expect(kinds.has('alternative-block')).toBe(true);
    expect(kinds.has('imperative-choice')).toBe(true);
  });

  it('exposes DECISION_HEURISTIC_VERSION as a positive integer', () => {
    expect(DECISION_HEURISTIC_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(DECISION_HEURISTIC_VERSION)).toBe(true);
  });
});

describe('runLabelingFunction', () => {
  it('runs a single LF in isolation and reports its hit kind/phrase', () => {
    const lf = findLf('explicit-marker');
    const hits = runLabelingFunction(lf, 'Decision: deploy on Friday');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.kind).toBe('explicit-marker');
  });

  it('returns no hits for pair-LFs without assistant context', () => {
    const lf = findLf('alternative-block');
    const hits = runLabelingFunction(lf, 'A', null);
    expect(hits).toEqual([]);
  });

  it('fires pair-LF when assistant context contains an options block', () => {
    const lf = findLf('alternative-block');
    const hits = runLabelingFunction(
      lf,
      'A',
      'Option A: refactor\nOption B: leave it',
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.kind).toBe('alternative-block');
  });

  it('respects scope: prefix-scoped LFs do not match past the lead', () => {
    const lf = findLf('imperative-choice');
    const longLead = 'x '.repeat(200); // ~400 chars filler past prefix window
    const hits = runLabelingFunction(lf, `${longLead} use vitest`);
    expect(hits).toEqual([]);
  });
});

describe('precedingAssistantExcerpt (v2 — trust-calibration input)', () => {
  it('carries the prior assistant turn, trimmed', () => {
    const out = detectDecisions([
      turn(1, 'Decision: ship it', '  go with the SDK, it is simpler  '),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.precedingAssistantExcerpt).toBe('go with the SDK, it is simpler');
  });

  it('is null when there is no preceding assistant turn', () => {
    const out = detectDecisions([turn(0, 'Decision: ship it', null)]);
    expect(out[0]?.precedingAssistantExcerpt).toBeNull();
  });

  it('truncates a long preceding assistant turn to the window', () => {
    const long = 'y'.repeat(900);
    const out = detectDecisions([turn(1, 'Decision: ship it', long)]);
    const got = out[0]?.precedingAssistantExcerpt ?? '';
    expect(got.length).toBeLessThanOrEqual(500);
    expect(got.endsWith('…')).toBe(true);
  });

  it('v2 bump: DECISION_HEURISTIC_VERSION is at least 2', () => {
    expect(DECISION_HEURISTIC_VERSION).toBeGreaterThanOrEqual(2);
  });
});
