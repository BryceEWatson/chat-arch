import { describe, it, expect } from 'vitest';
import {
  CORRECTION_LFS,
  computeLfFiringStats,
  detectCorrectionCandidates,
  runLabelingFunction,
  type TurnPair,
} from './detectCorrectionCandidates.js';

function turn(
  i: number,
  userText: string,
  precedingAssistantText: string | null = 'some assistant output',
): TurnPair {
  return { sessionId: 'sess1', userTurnIndex: i, userText, precedingAssistantText };
}

describe('detectCorrectionCandidates — recall (true positives must fire)', () => {
  it('fires on explicit-no patterns', () => {
    const out = detectCorrectionCandidates([
      turn(0, "Don't add docstrings unless I ask for them"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'explicit-no')).toBe(true);
  });

  it('fires on stop-imperative patterns', () => {
    const out = detectCorrectionCandidates([
      turn(0, 'Please stop adding emojis to commit messages'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'explicit-stop')).toBe(true);
  });

  it('fires on instead-of patterns', () => {
    const out = detectCorrectionCandidates([
      turn(0, 'Use ripgrep instead of grep for this codebase'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'instead-of')).toBe(true);
  });

  it('fires on ALL CAPS frustration markers', () => {
    const out = detectCorrectionCandidates([turn(0, 'NO, just edit the existing file')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'frustration')).toBe(true);
  });

  it('fires repeat-instruction when a 4-gram recurs after an assistant turn', () => {
    const out = detectCorrectionCandidates([
      turn(0, 'use kebab-case naming for component filenames'),
      turn(1, 'use kebab-case naming for component filenames'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.userTurnIndex).toBe(1);
    expect(out[0]?.signals.some((s) => s.kind === 'repeat-instruction')).toBe(true);
  });
});

describe('detectCorrectionCandidates — known false-positives (admitted by design)', () => {
  // These are the cases the adversarial review flagged. They DO fire under
  // the recall-first design. The LLM classification stage is responsible for
  // marking them `actionable: false`. Locking the admission here so a future
  // engineer doesn't "fix" them at this layer and silently destroy recall.

  it('admits "no, that worked!" — affirmative-sense use of "no"', () => {
    const out = detectCorrectionCandidates([turn(0, "no, that worked!")]);
    // The negation pattern requires "no" + "don't|not"; this should NOT fire
    // explicit-no. But "!!" / caps could hit frustration on other examples.
    expect(out).toHaveLength(0);
  });

  it('admits "stop the dev server" — imperative-stop targeting a tool', () => {
    const out = detectCorrectionCandidates([turn(0, 'stop the dev server')]);
    // "stop the" without an action verb (adding/generating/etc) does not match
    // STOP_PATTERNS; verifies the pattern is action-scoped, not bare-stop.
    expect(out).toHaveLength(0);
  });

  it('admits "actually that\'s correct" — affirmative-sense use of "actually"', () => {
    // Up through the 2026-05 audit this was suppressed at the recall layer.
    // The audit showed ~36 missed real corrections shaped "Actually, …" so
    // we now fire on turn-start `actually` regardless of polarity. The LLM
    // stage filters the affirmative cases as `actionable: false`.
    const out = detectCorrectionCandidates([
      turn(0, "actually that's correct, ship it"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'soft-redirect')).toBe(true);
  });
});

describe('detectCorrectionCandidates — recall expansion (2026-05 audit)', () => {
  it('fires on "Actually, …" soft redirects', () => {
    const out = detectCorrectionCandidates([
      turn(0, 'Actually, we should refresh existing heroes with detailed QA'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'soft-redirect')).toBe(true);
  });

  it('fires on "Wait, …" soft redirects', () => {
    const out = detectCorrectionCandidates([
      turn(0, "Wait, that's not how I want it structured"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'soft-redirect')).toBe(true);
  });

  it('fires on "Let\'s …" constructions', () => {
    const out = detectCorrectionCandidates([
      turn(0, "Let's regenerate any that have issues"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'soft-redirect')).toBe(true);
  });

  it('fires on "I would like …" preferences', () => {
    const out = detectCorrectionCandidates([
      turn(0, 'I would like to see more of the image'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'want-prefer')).toBe(true);
  });

  it("fires on \"I'd rather …\"", () => {
    const out = detectCorrectionCandidates([
      turn(0, "I'd rather you not assume the schema"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'want-prefer')).toBe(true);
  });

  it('fires on "I want …" preferences', () => {
    const out = detectCorrectionCandidates([
      turn(0, 'I want shorter responses going forward'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.signals.some((s) => s.kind === 'want-prefer')).toBe(true);
  });

  it("fires on broadened negation outside the original verb whitelist", () => {
    // 'change' / 'refactor' / 'assume' / 'touch' / 'mention' were missed
    // by the original whitelist. They should fire now.
    for (const verb of ['change', 'refactor', 'assume', 'touch', 'mention']) {
      const out = detectCorrectionCandidates([
        turn(0, `Don't ${verb} the existing API surface`),
      ]);
      expect(out, `verb=${verb}`).toHaveLength(1);
      expect(
        out[0]?.signals.some((s) => s.kind === 'explicit-no'),
        `verb=${verb}`,
      ).toBe(true);
    }
  });

  it('does NOT fire on common non-correction "don\'t worry" idiom', () => {
    // The exclusion list keeps these from inflating the candidate count
    // since the LLM stage would just have to reject them as not-actionable.
    for (const text of [
      "don't worry about it",
      "don't mind me",
      "don't think that's right",
      "don't know yet",
    ]) {
      const out = detectCorrectionCandidates([turn(0, text)]);
      expect(out, `text=${text}`).toHaveLength(0);
    }
  });

  it("fires on 'Just …' / 'Please …' imperatives at turn start", () => {
    const a = detectCorrectionCandidates([
      turn(0, 'Just create the new public one first'),
    ]);
    expect(a).toHaveLength(1);
    expect(a[0]?.signals.some((s) => s.kind === 'imperative-override')).toBe(true);
    const b = detectCorrectionCandidates([
      turn(0, 'Please use kebab-case for filenames'),
    ]);
    expect(b).toHaveLength(1);
    expect(b[0]?.signals.some((s) => s.kind === 'imperative-override')).toBe(true);
  });
});

describe('detectCorrectionCandidates — output shape', () => {
  it('emits classification: null for every candidate', () => {
    const out = detectCorrectionCandidates([
      turn(0, "don't add comments to generated code"),
    ]);
    expect(out[0]?.classification).toBeNull();
  });

  it('truncates excerpts longer than 500 chars with ellipsis', () => {
    const long = "don't add " + 'x'.repeat(600);
    const out = detectCorrectionCandidates([turn(0, long)]);
    expect(out[0]?.excerpt.length).toBe(500);
    expect(out[0]?.excerpt.endsWith('…')).toBe(true);
  });

  it('produces stable ids for the same (sessionId, turnIndex)', () => {
    const a = detectCorrectionCandidates([turn(3, "don't add foo")]);
    const b = detectCorrectionCandidates([turn(3, "don't add foo")]);
    expect(a[0]?.id).toBe(b[0]?.id);
  });
});

describe('CORRECTION_LFS', () => {
  it('exposes the full LF registry with unique names and known kinds', () => {
    const names = new Set<string>();
    for (const lf of CORRECTION_LFS) {
      expect(lf.name.length).toBeGreaterThan(0);
      expect(names.has(lf.name)).toBe(false);
      names.add(lf.name);
      expect(['full', 'prefix']).toContain(lf.scope);
      expect(lf.patterns.length).toBeGreaterThan(0);
    }
    // Every documented signal kind should be represented by at least
    // one LF — this catches accidental kind deletions during refactor.
    const kinds = new Set(CORRECTION_LFS.map((lf) => lf.kind));
    expect(kinds.has('explicit-stop')).toBe(true);
    expect(kinds.has('explicit-no')).toBe(true);
    expect(kinds.has('instead-of')).toBe(true);
    expect(kinds.has('imperative-override')).toBe(true);
    expect(kinds.has('frustration')).toBe(true);
    expect(kinds.has('soft-redirect')).toBe(true);
    expect(kinds.has('want-prefer')).toBe(true);
  });
});

describe('runLabelingFunction', () => {
  it('runs a single LF in isolation and reports its hit kind/phrase', () => {
    const lf = CORRECTION_LFS.find((l) => l.name === 'imperative-override');
    expect(lf).toBeDefined();
    const hits = runLabelingFunction(lf!, 'Always use kebab-case for filenames');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.kind).toBe('imperative-override');
    expect(hits[0]?.phrase.toLowerCase()).toContain('always');
  });

  it('returns no hits when the LF does not match', () => {
    const lf = CORRECTION_LFS.find((l) => l.name === 'imperative-override');
    expect(lf).toBeDefined();
    const hits = runLabelingFunction(lf!, 'That worked perfectly, thanks!');
    expect(hits).toEqual([]);
  });

  it('respects scope: prefix-scoped LFs do not match material past the lead', () => {
    const softRedirect = CORRECTION_LFS.find((l) => l.name === 'soft-redirect');
    expect(softRedirect).toBeDefined();
    // Plant "actually" past the 300-char prefix window — should NOT fire.
    const longLead = 'x '.repeat(200); // ~400 chars of filler
    const hits = runLabelingFunction(softRedirect!, `${longLead} actually that's wrong`);
    expect(hits).toEqual([]);
    // Same marker in the lead → fires.
    const inLead = runLabelingFunction(softRedirect!, "actually that's wrong");
    expect(inLead.length).toBeGreaterThan(0);
  });
});

describe('computeLfFiringStats', () => {
  it('counts each kind once per correction, even if multiple LFs of that kind fire', () => {
    // "don't change X" should fire BOTH explicit-no.whitelist (no-not
    // pattern won't, but the broadened verb-anything pattern will) and
    // potentially imperative-override. We want firingsByKind to count
    // each Correction once per UNIQUE kind, not per LF.
    const corrections = detectCorrectionCandidates([
      turn(0, "don't change the file naming convention"),
      turn(2, 'use kebab-case instead of camelCase'),
    ]);
    const stats = computeLfFiringStats(corrections);
    // First turn has explicit-no; second has instead-of (+ possibly more).
    expect(stats.totalCorrections).toBe(corrections.length);
    expect(stats.firingsByKind.get('explicit-no') ?? 0).toBeGreaterThanOrEqual(1);
    expect(stats.firingsByKind.get('instead-of') ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('returns zero counts on an empty corrections array', () => {
    const stats = computeLfFiringStats([]);
    expect(stats.totalCorrections).toBe(0);
    expect(stats.firingsByKind.size).toBe(0);
    expect(stats.agreement.size).toBe(0);
  });

  it('records pairwise agreement when two kinds co-fire on the same correction', () => {
    // "NO, don't add docstrings" should fire BOTH explicit-no AND
    // frustration (capslocked NO).
    const corrections = detectCorrectionCandidates([
      turn(0, "NO, don't add docstrings unless asked"),
    ]);
    // Sanity: the input fires both kinds.
    const kinds = new Set(corrections[0]?.signals.map((s) => s.kind) ?? []);
    expect(kinds.has('explicit-no')).toBe(true);
    expect(kinds.has('frustration')).toBe(true);

    const stats = computeLfFiringStats(corrections);
    // Agreement keys are sorted alphabetically; explicit-no < frustration.
    expect(stats.agreement.get('explicit-no|frustration')).toBe(1);
  });
});
