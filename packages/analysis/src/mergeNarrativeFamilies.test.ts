import { describe, it, expect, vi } from 'vitest';
import type { Narrative } from '@chat-arch/schema';
import { mergeNarrativeFamilies } from './mergeNarrativeFamilies.js';

function mkRow(
  id: string,
  projectId: string,
  attributedTo: Narrative['attributedTo'],
  overrides: Partial<Narrative> = {},
): Narrative {
  return {
    id,
    projectId,
    sessionIds: ['s1', 's2'],
    sentiment: 'positive',
    title: id,
    body: 'b',
    evidence: [],
    generatedAt: new Date(0).toISOString(),
    actionType: 'encode-as-pattern',
    schemaVersion: attributedTo === 'llm-derived' ? 2 : 1,
    attributedTo,
    confidence: attributedTo === 'llm-derived' ? 0.5 : undefined,
    supportingCount: attributedTo === 'llm-derived' ? 2 : undefined,
    contradictingCount: attributedTo === 'llm-derived' ? 0 : undefined,
    ...overrides,
  };
}

describe('mergeNarrativeFamilies', () => {
  it('(a) empty heuristic → result is existingLlm ∪ incomingLlm', () => {
    const a = mkRow('narr_llm_proj_a_1', 'proj_a', 'llm-derived');
    const b = mkRow('narr_llm_proj_b_1', 'proj_b', 'llm-derived');
    const r = mergeNarrativeFamilies({
      heuristic: [],
      existingLlm: [a],
      incomingLlm: [b],
    });
    expect(r.map((x) => x.id)).toEqual(
      expect.arrayContaining(['narr_llm_proj_a_1', 'narr_llm_proj_b_1']),
    );
    expect(r).toHaveLength(2);
  });

  it('(b) empty existingLlm + empty incomingLlm → result is heuristic only', () => {
    const h = mkRow('narr_proj_x_positive_abc', 'proj_x', 'deterministic');
    const r = mergeNarrativeFamilies({
      heuristic: [h],
      existingLlm: [],
    });
    expect(r).toEqual([h]);
  });

  it('preserves all heuristic rows AND appends all LLM rows', () => {
    const h1 = mkRow('narr_proj_x_positive_a', 'proj_x', 'deterministic');
    const h2 = mkRow('narr_proj_x_negative_b', 'proj_x', 'deterministic');
    const llm1 = mkRow('narr_llm_proj_x_1', 'proj_x', 'llm-derived');
    const r = mergeNarrativeFamilies({
      heuristic: [h1, h2],
      existingLlm: [llm1],
    });
    expect(r).toHaveLength(3);
    // Heuristic rows first per edge case (e).
    expect(r[0]?.id).toBe('narr_proj_x_positive_a');
    expect(r[1]?.id).toBe('narr_proj_x_negative_b');
    expect(r[2]?.id).toBe('narr_llm_proj_x_1');
  });

  it('(c) id collision between heuristic and LLM → drops LLM row with warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const shared = 'narr_collide_xyz';
      const h = mkRow(shared, 'proj_x', 'deterministic');
      const llm = mkRow(shared, 'proj_x', 'llm-derived');
      const r = mergeNarrativeFamilies({
        heuristic: [h],
        existingLlm: [llm],
      });
      expect(r).toHaveLength(1);
      expect(r[0]?.attributedTo).toBe('deterministic');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('(d) mode = { projectId } with off-project incoming row → drops off-project, retains in-project', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const inProj = mkRow('narr_llm_proj_x_in', 'proj_x', 'llm-derived');
      const offProj = mkRow('narr_llm_proj_y_off', 'proj_y', 'llm-derived');
      const r = mergeNarrativeFamilies({
        heuristic: [],
        existingLlm: [],
        incomingLlm: [inProj, offProj],
        mode: { projectId: 'proj_x' },
      });
      expect(r.map((x) => x.id)).toEqual(['narr_llm_proj_x_in']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('mode = { projectId } replaces only THAT project\'s LLM rows; others preserved', () => {
    const xOld = mkRow('narr_llm_proj_x_old', 'proj_x', 'llm-derived');
    const yOld = mkRow('narr_llm_proj_y_old', 'proj_y', 'llm-derived');
    const xNew = mkRow('narr_llm_proj_x_new', 'proj_x', 'llm-derived');
    const r = mergeNarrativeFamilies({
      heuristic: [],
      existingLlm: [xOld, yOld],
      incomingLlm: [xNew],
      mode: { projectId: 'proj_x' },
    });
    const ids = r.map((x) => x.id).sort();
    expect(ids).toEqual(['narr_llm_proj_x_new', 'narr_llm_proj_y_old']);
  });

  it('mode = "full-rewrite" replaces an existing LLM row when its projectId appears in incoming', () => {
    const xOld = mkRow('narr_llm_proj_x_old', 'proj_x', 'llm-derived');
    const yOld = mkRow('narr_llm_proj_y_old', 'proj_y', 'llm-derived');
    const xNew = mkRow('narr_llm_proj_x_new', 'proj_x', 'llm-derived');
    const r = mergeNarrativeFamilies({
      heuristic: [],
      existingLlm: [xOld, yOld],
      incomingLlm: [xNew],
      mode: 'full-rewrite',
    });
    const ids = r.map((x) => x.id).sort();
    // proj_x's old LLM row evicted; proj_y untouched.
    expect(ids).toEqual(['narr_llm_proj_x_new', 'narr_llm_proj_y_old']);
  });

  it('(e) sort order: heuristic first, then LLM by confidence desc within projectId', () => {
    const h = mkRow('narr_proj_x_positive_h', 'proj_x', 'deterministic');
    const low = mkRow('narr_llm_proj_x_low', 'proj_x', 'llm-derived', {
      confidence: 0.4,
    });
    const high = mkRow('narr_llm_proj_x_high', 'proj_x', 'llm-derived', {
      confidence: 0.8,
    });
    const r = mergeNarrativeFamilies({
      heuristic: [h],
      existingLlm: [low, high],
    });
    expect(r.map((x) => x.id)).toEqual([
      'narr_proj_x_positive_h',
      'narr_llm_proj_x_high',
      'narr_llm_proj_x_low',
    ]);
  });

  it('(f) mode = garbage type → TypeError', () => {
    expect(() =>
      mergeNarrativeFamilies({
        heuristic: [],
        existingLlm: [],
        // @ts-expect-error testing runtime guard
        mode: 42,
      }),
    ).toThrow(TypeError);
    expect(() =>
      mergeNarrativeFamilies({
        heuristic: [],
        existingLlm: [],
        // @ts-expect-error testing runtime guard
        mode: { wrongKey: 'proj_x' },
      }),
    ).toThrow(TypeError);
  });

  it('legacy row missing attributedTo on EXISTING LLM is treated normally (caller normalizes)', () => {
    // The merge helper assumes the caller has classified rows via
    // classifyAttribution(normalizeNarrativeRow(row)) before passing
    // them in. A row without attributedTo that the caller still
    // routed into `existingLlm` is the caller's bug — the merge just
    // preserves the row as-given. This test pins that behavior.
    const llmish = mkRow('narr_legacy', 'proj_x', undefined);
    const r = mergeNarrativeFamilies({
      heuristic: [],
      existingLlm: [llmish],
    });
    expect(r).toEqual([llmish]);
  });

  it('id collision with incoming LLM row (not existing) also drops with warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const shared = 'narr_collide_inc';
      const h = mkRow(shared, 'proj_x', 'deterministic');
      const inc = mkRow(shared, 'proj_x', 'llm-derived');
      const r = mergeNarrativeFamilies({
        heuristic: [h],
        existingLlm: [],
        incomingLlm: [inc],
      });
      expect(r).toHaveLength(1);
      expect(r[0]?.attributedTo).toBe('deterministic');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
