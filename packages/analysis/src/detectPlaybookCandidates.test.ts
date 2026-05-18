import { describe, it, expect } from 'vitest';
import {
  detectPlaybookCandidates,
  PLAYBOOK_PATTERN_META,
  type PlaybookTurnInput,
} from './detectPlaybookCandidates.js';

function turn(
  i: number,
  userText: string,
  lineNumber: number = 10 + i * 2,
): PlaybookTurnInput {
  return { sessionId: 'sess1', userTurnIndex: i, userText, lineNumber };
}

describe('detectPlaybookCandidates — ground-truth phrasings must surface', () => {
  // The two anchor examples from project_methods_playbook memory. If
  // either of these stops firing, the detector has regressed — these
  // are the canonical positive cases the surface is built to expose.

  it('surfaces "go back to first principles"', () => {
    const hits = detectPlaybookCandidates([
      turn(
        0,
        "OK before you do anything else, go back to first principles. Pretend the previous attempt doesn't exist.",
      ),
    ]);
    const keys = hits.map((h) => h.patternKey);
    expect(keys).toContain('first-principles');
  });

  it('surfaces "use an adversarial review team"', () => {
    const hits = detectPlaybookCandidates([
      turn(0, 'Use an adversarial review team to break the plan before we ship.'),
    ]);
    const keys = hits.map((h) => h.patternKey);
    expect(keys).toContain('adversarial-review');
  });

  it('preserves transcript lineNumber on every hit (for downstream audit join)', () => {
    const hits = detectPlaybookCandidates([
      turn(0, "Let's reason from first principles here.", /* lineNumber */ 137),
    ]);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.lineNumber).toBe(137);
      expect(h.sessionId).toBe('sess1');
      expect(h.userTurnIndex).toBe(0);
    }
  });
});

describe('detectPlaybookCandidates — coverage across pattern families', () => {
  const cases: Array<{ key: string; text: string }> = [
    { key: 'step-back', text: "Hold on — let's step back and look at the problem shape." },
    { key: 'deep-think', text: 'Ultrathink this one and then propose.' },
    { key: 'verify-validate', text: 'Double-check the migration before we commit.' },
    { key: 'plan-first', text: 'Plan first, then implement — no edits until the plan is solid.' },
    { key: 'subagent-fanout', text: 'Run those two investigations in parallel using subagents.' },
    { key: 'what-am-i-missing', text: 'What am I missing here? Walk me through the blind spots.' },
    { key: 'tradeoffs', text: 'What are the alternatives and the trade-offs between them?' },
  ];

  for (const c of cases) {
    it(`fires on pattern family: ${c.key}`, () => {
      const hits = detectPlaybookCandidates([turn(0, c.text)]);
      expect(hits.map((h) => h.patternKey)).toContain(c.key);
    });
  }

  it('exposes label + description metadata for every key the kernel can emit', () => {
    // Defensive: the on-disk sidecar references this catalogue, and the
    // page renders labels straight from it. A key without metadata
    // would render a blank row.
    const allEmittableKeys = new Set<string>();
    for (const c of cases) {
      const hits = detectPlaybookCandidates([turn(0, c.text)]);
      for (const h of hits) allEmittableKeys.add(h.patternKey);
    }
    // Plus the two anchors:
    allEmittableKeys.add('first-principles');
    allEmittableKeys.add('adversarial-review');
    for (const k of allEmittableKeys) {
      const meta = PLAYBOOK_PATTERN_META.get(k);
      expect(meta, `meta missing for pattern key '${k}'`).toBeDefined();
      expect(meta?.label.length).toBeGreaterThan(0);
      expect(meta?.description.length).toBeGreaterThan(0);
    }
  });
});

describe('detectPlaybookCandidates — admitted noise / filters', () => {
  it('skips trivially short user text', () => {
    const hits = detectPlaybookCandidates([turn(0, 'ok')]);
    expect(hits).toEqual([]);
  });

  it('returns empty for an unrelated user turn', () => {
    const hits = detectPlaybookCandidates([
      turn(0, 'Can you bump the version number in package.json please'),
    ]);
    expect(hits).toEqual([]);
  });

  it('emits one hit per matched family per turn (no within-family duplicates)', () => {
    // Plan-first has two regex arms; a turn that satisfies both should
    // still produce a single hit for the family.
    const hits = detectPlaybookCandidates([
      turn(0, 'Plan first — before you implementing anything please plan it out.'),
    ]);
    const planFirstHits = hits.filter((h) => h.patternKey === 'plan-first');
    expect(planFirstHits.length).toBe(1);
  });

  it('emits multiple hits when one turn invokes multiple distinct families', () => {
    // Defensive: the per-family `break` must not collapse hits ACROSS
    // families. A turn invoking both first-principles AND adversarial-
    // review should produce two hits, one per family.
    const hits = detectPlaybookCandidates([
      turn(
        0,
        "Let's go back to first principles, then run an adversarial review team on the resulting plan.",
      ),
    ]);
    const keys = hits.map((h) => h.patternKey).sort();
    expect(keys).toContain('first-principles');
    expect(keys).toContain('adversarial-review');
  });
});
