import { describe, it, expect } from 'vitest';
import {
  DEMO_SID_PREFIX,
  makeDemoBlogDraftSlugs,
  makeDemoCuratorFeed,
  makeDemoLatestBrief,
  makeDemoRecentNarratives,
  makeDemoSurprises,
  makeDemoTopAuditConcerns,
  makeDemoWorkshopStatus,
} from '../../src/lib/demoFixtures.ts';

// Phase β review-loop iter-1 fix tests. demoFixtures.ts grew four new
// constructors (makeDemoLatestBrief / makeDemoSurprises /
// makeDemoCuratorFeed / makeDemoRecentNarratives) when the FEED
// redesign added four new empty-state sites without populated demo
// data. These tests pin the contract:
//
//   1. Shape conformance — each constructor returns the type its
//      readSidecars / @chat-arch/analysis counterpart returns. The TS
//      compiler catches drift, but the runtime expects also cover
//      the "must include field X" rules the type doesn't encode.
//   2. Determinism — same call → same output. The constructors are
//      pure; review-loop's positioning-by-features check relies on
//      stable output for snapshot tests of the rendered TODAY page.
//   3. DEMO_SID_PREFIX usage — every session-ID reference uses the
//      sentinel `demo0000-...` prefix so the empty-state-contracts
//      test's SID-leak guard rejects any non-demo 8-hex SID slip.

describe('makeDemoLatestBrief', () => {
  it('returns the shape readLatestBrief() returns: { date, markdown }', () => {
    const brief = makeDemoLatestBrief();
    expect(typeof brief.date).toBe('string');
    expect(brief.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof brief.markdown).toBe('string');
    expect(brief.markdown.length).toBeGreaterThan(0);
  });

  it('includes all 4 expected section bullets', () => {
    const { markdown } = makeDemoLatestBrief();
    // The brief synthesizes 4 buckets: audit concerns, shipped, surprises,
    // continuum health. Pin each so a copy edit doesn't silently break the
    // shape the user is meant to learn from.
    expect(markdown).toMatch(/audit concern/);
    expect(markdown).toMatch(/Shipped this week/);
    expect(markdown).toMatch(/Surprises today/);
    expect(markdown).toMatch(/Continuum health/);
  });

  it('uses DEMO_SID_PREFIX for any session-ID references', () => {
    const { markdown } = makeDemoLatestBrief();
    // Any [SID:abc12345] mention must start with the demo prefix sentinel.
    const sids = [...markdown.matchAll(/\[SID:([0-9a-f]{8,})\]/gi)];
    for (const m of sids) {
      expect(m[1].toLowerCase()).toMatch(/^demo/);
    }
  });

  it('is deterministic — same call returns identical output', () => {
    expect(makeDemoLatestBrief()).toEqual(makeDemoLatestBrief());
  });
});

describe('makeDemoSurprises', () => {
  it('returns the SurprisesOutput shape', () => {
    const out = makeDemoSurprises();
    expect(out.version).toBe(1);
    expect(typeof out.generatedAt).toBe('number');
    expect(Array.isArray(out.surprises)).toBe(true);
    expect(out.thresholds).toBeDefined();
    // Threshold snapshot fields the kernel pins.
    expect(typeof out.thresholds.streakMin).toBe('number');
    expect(typeof out.thresholds.reflexiveEValueMin).toBe('number');
  });

  it('includes 3 positive + 2 concerning surprises across varied kinds', () => {
    const out = makeDemoSurprises();
    const positives = out.surprises.filter((s) => s.tone === 'positive');
    const concerning = out.surprises.filter((s) => s.tone === 'concerning');
    expect(positives.length).toBe(3);
    expect(concerning.length).toBe(2);
    // Kind variety check — at least 4 distinct kinds across the 5 rows.
    const kinds = new Set(out.surprises.map((s) => s.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });

  it('every summary is ≤ 120 chars (Surprise contract)', () => {
    for (const s of makeDemoSurprises().surprises) {
      expect(s.summary.length).toBeLessThanOrEqual(120);
    }
  });

  it('every session-ID reference uses DEMO_SID_PREFIX', () => {
    for (const s of makeDemoSurprises().surprises) {
      for (const sid of s.evidence.sessionIds ?? []) {
        expect(sid.startsWith(DEMO_SID_PREFIX)).toBe(true);
      }
    }
  });

  it('every projectId reference uses `demo-project-` prefix', () => {
    for (const s of makeDemoSurprises().surprises) {
      if (s.evidence.projectId !== undefined) {
        expect(s.evidence.projectId).toMatch(/^demo-project-/);
      }
    }
  });

  it('uses a fixed generatedAt for snapshot determinism', () => {
    const a = makeDemoSurprises();
    const b = makeDemoSurprises();
    expect(a.generatedAt).toBe(b.generatedAt);
    // Per-row generatedAt mirrors the file-level value.
    for (const s of a.surprises) {
      expect(s.generatedAt).toBe(a.generatedAt);
    }
  });

  it('is deterministic — same call returns identical output', () => {
    expect(makeDemoSurprises()).toEqual(makeDemoSurprises());
  });
});

describe('makeDemoCuratorFeed', () => {
  it('returns the CuratorFeedFileSsr shape', () => {
    const feed = makeDemoCuratorFeed();
    expect(feed.schemaVersion).toBe(1);
    expect(typeof feed.generatedAt).toBe('number');
    expect(typeof feed.ranAt).toBe('string');
    expect(Array.isArray(feed.items)).toBe(true);
  });

  it('includes 4-5 items mixing all three kinds', () => {
    const feed = makeDemoCuratorFeed();
    expect(feed.items.length).toBeGreaterThanOrEqual(4);
    expect(feed.items.length).toBeLessThanOrEqual(5);
    const kinds = new Set(feed.items.map((i) => i.kind));
    // narrative / knowledge-debt / applied-pattern — at least 3 distinct.
    expect(kinds.has('narrative')).toBe(true);
    expect(kinds.has('knowledge-debt')).toBe(true);
    expect(kinds.has('applied-pattern')).toBe(true);
  });

  it('ranks are positive integers with no duplicates', () => {
    const feed = makeDemoCuratorFeed();
    const ranks = feed.items.map((i) => i.rank);
    for (const r of ranks) {
      expect(Number.isInteger(r) && r > 0).toBe(true);
    }
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('compositeScores are within [0, 1]', () => {
    for (const item of makeDemoCuratorFeed().items) {
      expect(item.compositeScore).toBeGreaterThanOrEqual(0);
      expect(item.compositeScore).toBeLessThanOrEqual(1);
    }
  });

  it('at least one item is verified (drives the green pill)', () => {
    const items = makeDemoCuratorFeed().items;
    expect(items.some((i) => i.falsifierStatus === 'verified')).toBe(true);
  });

  it('is deterministic — same call returns identical output', () => {
    expect(makeDemoCuratorFeed()).toEqual(makeDemoCuratorFeed());
  });
});

describe('makeDemoRecentNarratives', () => {
  it('returns 5 RecentNarrative rows', () => {
    const rows = makeDemoRecentNarratives();
    expect(rows.length).toBe(5);
  });

  it('exercises all three sentiment buckets', () => {
    const rows = makeDemoRecentNarratives();
    const sentiments = new Set(rows.map((r) => r.sentiment));
    expect(sentiments.has('positive')).toBe(true);
    expect(sentiments.has('negative')).toBe(true);
    expect(sentiments.has('neutral')).toBe(true);
  });

  it('every session-ID uses DEMO_SID_PREFIX', () => {
    for (const row of makeDemoRecentNarratives()) {
      for (const sid of row.sessionIds) {
        expect(sid.startsWith(DEMO_SID_PREFIX)).toBe(true);
      }
    }
  });

  it('every projectId uses `demo-project-` prefix', () => {
    for (const row of makeDemoRecentNarratives()) {
      expect(row.projectId).toMatch(/^demo-project-/);
    }
  });

  it('generatedAt strings parse to valid ISO dates (for .slice(0,10) crop)', () => {
    for (const row of makeDemoRecentNarratives()) {
      const d = new Date(row.generatedAt);
      expect(Number.isFinite(d.getTime())).toBe(true);
      expect(row.generatedAt.slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('is deterministic — same call returns identical output', () => {
    expect(makeDemoRecentNarratives()).toEqual(makeDemoRecentNarratives());
  });
});

// Smoke-test the pre-existing demo constructors to lock the import
// surface (so a future export-rename breaks here loudly, not in a
// downstream call site).
describe('pre-existing demo constructors — import surface', () => {
  it('makeDemoWorkshopStatus returns an object', () => {
    expect(typeof makeDemoWorkshopStatus()).toBe('object');
  });
  it('makeDemoTopAuditConcerns returns an array', () => {
    expect(Array.isArray(makeDemoTopAuditConcerns())).toBe(true);
  });
  it('makeDemoBlogDraftSlugs returns an array', () => {
    expect(Array.isArray(makeDemoBlogDraftSlugs())).toBe(true);
  });
});
