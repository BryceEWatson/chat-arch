import { describe, it, expect } from 'vitest';
import { generateDemoUpload } from './demoUpload.js';

// Phase 4 — demo fixture must include corrections + applied + a
// synthesized rescan delta so the workshop loop is visible on the
// hosted demo path. Without these, a hosted visitor sees the SESSIONS
// grid but the CORRECTIONS surface is empty — defeating the demo's
// purpose (Priya's persona finding).

describe('generateDemoUpload — Phase 4 corrections fixture', () => {
  it('returns a corrections file with multiple patterns spanning the three buckets', () => {
    const data = generateDemoUpload();
    expect(data.corrections).toBeDefined();
    const file = data.corrections!;
    expect(file.patterns.length).toBeGreaterThanOrEqual(4);
    expect(file.patterns.length).toBeLessThanOrEqual(8);

    // Each bucket represented at least once. Bucket categorization
    // mirrors CorrectionsPanel.BUCKET_DEFS: recurring-after-applied
    // (red) → already-encoded-but-not-recurring (yellow) → new (default).
    const hasRecurring = file.patterns.some((p) => p.recurringPostApplication);
    const hasEncodedNotRecurring = file.patterns.some(
      (p) => p.alreadyEncoded && !p.recurringPostApplication,
    );
    const hasNew = file.patterns.some(
      (p) => !p.recurringPostApplication && !p.alreadyEncoded,
    );
    expect(hasRecurring).toBe(true);
    expect(hasEncodedNotRecurring).toBe(true);
    expect(hasNew).toBe(true);
  });

  it('every pattern has at least 3 instance Correction entries', () => {
    const file = generateDemoUpload().corrections!;
    for (const p of file.patterns) {
      expect(p.instanceIds.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('every pattern has at least one ProposedUpgrade with a real target + patch', () => {
    const file = generateDemoUpload().corrections!;
    for (const p of file.patterns) {
      expect(p.proposedUpgrades.length).toBeGreaterThanOrEqual(1);
      for (const u of p.proposedUpgrades) {
        expect(u.target).toBeTruthy();
        expect(u.targetPath).toBeTruthy();
        expect(u.patch.length).toBeGreaterThan(20);
        expect(u.rationale.length).toBeGreaterThan(10);
        expect(u.applied).toBe(false);
        expect(u.appliedAt).toBeNull();
      }
    }
  });

  it('correction instanceIds resolve to actual Correction.id entries', () => {
    const file = generateDemoUpload().corrections!;
    const allIds = new Set(file.corrections.map((c) => c.id));
    for (const p of file.patterns) {
      for (const id of p.instanceIds) {
        expect(allIds.has(id)).toBe(true);
      }
    }
  });

  it('correction instances reference real demo session ids that resolve in the manifest', () => {
    // If the synthesis order changes, these IDs need re-pinning. The
    // panel's instance-pill clickthrough drills into a session by id,
    // so a dangling reference would dump the user on a 404-ish blank
    // detail surface.
    const data = generateDemoUpload();
    const sessionIds = new Set(data.manifest.sessions.map((s) => s.id));
    for (const c of data.corrections!.corrections) {
      expect(sessionIds.has(c.sessionId)).toBe(true);
    }
  });
});

describe('generateDemoUpload — Phase 4 applied-improvements ledger', () => {
  it('returns an applied-improvements file with at least 2 entries', () => {
    const data = generateDemoUpload();
    expect(data.appliedImprovements).toBeDefined();
    expect(data.appliedImprovements!.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('each applied entry references a real demo pattern id', () => {
    const data = generateDemoUpload();
    const patternIds = new Set(data.corrections!.patterns.map((p) => p.id));
    for (const entry of data.appliedImprovements!.entries) {
      expect(patternIds.has(entry.patternId)).toBe(true);
    }
  });

  it('the older applied entry maps to a pattern in the recurring-after-applied bucket', () => {
    // Proves the loop visually — the user patched 30 days ago and
    // the model is still failing the rule.
    const data = generateDemoUpload();
    const entries = data.appliedImprovements!.entries;
    // Pick the entry with the oldest appliedAt.
    const oldest = entries.reduce((a, b) => (a.appliedAt < b.appliedAt ? a : b));
    const matchingPattern = data.corrections!.patterns.find(
      (p) => p.id === oldest.patternId,
    );
    expect(matchingPattern).toBeDefined();
    expect(matchingPattern!.recurringPostApplication).toBe(true);
  });

  it('applied entry timestamps span both ~7d and ~30d windows', () => {
    const data = generateDemoUpload();
    const now = Date.now();
    const ages = data
      .appliedImprovements!.entries.map((e) => now - e.appliedAt)
      .map((ms) => ms / (24 * 3_600_000));
    // At least one entry between 5 and 10 days old; at least one
    // between 25 and 35 days old. A loose window so a slow CI run
    // doesn't flake.
    expect(ages.some((d) => d >= 5 && d <= 10)).toBe(true);
    expect(ages.some((d) => d >= 25 && d <= 35)).toBe(true);
  });
});

// PR #34 ships a `headline?: string` on ProposedUpgrade — the lead-with-
// punchline card layout falls back to a derived headline when missing,
// but the demo fixture's whole purpose is to showcase the punchline, so
// every bundled upgrade should ship an explicit headline.
describe('generateDemoUpload — Phase 4 ProposedUpgrade headline', () => {
  it('every ProposedUpgrade in the demo fixture ships a non-empty headline', () => {
    const data = generateDemoUpload();
    for (const p of data.corrections!.patterns) {
      for (const u of p.proposedUpgrades) {
        expect(typeof u.headline).toBe('string');
        expect((u.headline ?? '').length).toBeGreaterThan(10);
      }
    }
  });
});

// PR #33 ships pipeline-stage markers (✓ EXPORTER SCAN / ▶ LLM MINE)
// gated on a non-empty `correctionCandidates.scanStats`. Without this
// payload on the demo path the entire stage UI ships invisible.
describe('generateDemoUpload — Phase 4 corrections candidates fixture', () => {
  it('bundles a candidates file with scanStats so the CoverageMeter mounts', () => {
    const data = generateDemoUpload();
    expect(data.correctionCandidates).toBeDefined();
    const cands = data.correctionCandidates!;
    expect(cands.corrections.length).toBeGreaterThan(0);
    expect(cands.scanStats).toBeDefined();
    const stats = cands.scanStats!;
    expect(stats.sessionsInManifest).toBeGreaterThan(0);
    expect(stats.sessionsScanned).toBeGreaterThan(0);
    expect(Object.keys(stats.sessionsBySource).length).toBeGreaterThanOrEqual(2);
    // Stage markers split missing/crashed — both should be exercised
    // by the demo so the split-note rendering is visible.
    expect(stats.sessionsCrashedBySource).toBeDefined();
    const crashedTotal = Object.values(stats.sessionsCrashedBySource ?? {}).reduce(
      (a, b) => a + b,
      0,
    );
    expect(crashedTotal).toBeGreaterThan(0);
  });
});

describe('generateDemoUpload — Phase 4 synthesized rescan delta', () => {
  it('includes a synthesizedRescanDelta with plausible per-source counts', () => {
    const data = generateDemoUpload();
    expect(data.synthesizedRescanDelta).toBeDefined();
    const d = data.synthesizedRescanDelta!;
    expect(d.totalLocal).toBeGreaterThan(0);
    expect(d.cowork + d.cli + d.desktop).toBe(d.totalLocal);
  });
});

describe('generateDemoUpload — corrections content guardrails (ESL-clean)', () => {
  it('does not contain swearing, real company names, or PII patterns', () => {
    const data = generateDemoUpload();
    const blob = JSON.stringify(data.corrections);
    // A non-exhaustive but useful sanity net.
    const banned = [
      // Light-touch profanity check; the fixture is hand-authored and
      // should never need these.
      /\bfuck/i,
      /\bshit/i,
      // Real-domain emails would be PII.
      /@(gmail|outlook|yahoo)\.com/i,
      // Specific real company names that shouldn't be in a demo
      // fixture (hand-curated; expand if a future demo edit slips in).
      /\bGoogle\b/,
      /\bMicrosoft\b/,
      /\bOpenAI\b/,
    ];
    for (const re of banned) {
      expect(blob).not.toMatch(re);
    }
  });
});
