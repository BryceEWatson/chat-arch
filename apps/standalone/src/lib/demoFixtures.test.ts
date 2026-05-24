import { describe, it, expect } from 'vitest';
import {
  DEMO_SID_PREFIX,
  makeDemoBlogDraftSlugs,
  makeDemoTopAuditConcerns,
  makeDemoWorkshopStatus,
} from './demoFixtures.ts';

// Guardrails mirror packages/viewer/src/data/demoUpload.test.ts. The
// principle (memory: feedback_positioning_by_features) is meaningful
// only if the demo content is safe to ship publicly. Any verbatim
// CLAUDE.md rule text, real-domain email, or real session-ID prefix
// would be a soft-leak.

const ALL_DEMO_CONTENT = (): string => {
  const ws = makeDemoWorkshopStatus();
  const audit = makeDemoTopAuditConcerns();
  const drafts = makeDemoBlogDraftSlugs();
  return JSON.stringify({ ws, audit, drafts });
};

describe('demoFixtures — content guardrails', () => {
  it('DEMO_SID_PREFIX is the canonical sentinel', () => {
    expect(DEMO_SID_PREFIX).toBe('demo0000-0000-0000-0000-');
  });

  it('every demo session ID starts with DEMO_SID_PREFIX', () => {
    const blob = ALL_DEMO_CONTENT();
    // Any uuid-shaped string in the blob must start with `demo`.
    const uuidLike = [
      ...blob.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi),
    ];
    expect(uuidLike.length).toBeGreaterThan(0);
    for (const m of uuidLike) {
      expect(m[0].toLowerCase()).toMatch(/^demo/);
    }
  });

  it('contains no real-domain email addresses', () => {
    const blob = ALL_DEMO_CONTENT();
    // Crude email regex; if we ever need fake emails they should be at
    // example.com / .invalid / .test (RFC reserved).
    const emails = [
      ...blob.matchAll(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g),
    ];
    for (const m of emails) {
      expect(m[0]).toMatch(/@(example\.(com|org|net)|.*\.(invalid|test))$/i);
    }
  });

  it('contains no real company names', () => {
    // Same list as demoUpload.test.ts. If the demo blob mentions any
    // of these strings we've leaked something we shouldn't.
    const realCompanies = [
      'Google',
      'Microsoft',
      'Amazon',
      'Apple',
      'Meta',
      'Facebook',
      'OpenAI',
      'Anthropic',
      'GitHub',
      'Stripe',
    ];
    const blob = ALL_DEMO_CONTENT();
    for (const c of realCompanies) {
      // Use word boundary so we don't false-positive on github.com URLs
      // in legitimate metadata fields.
      const re = new RegExp(`\\b${c}\\b`);
      expect(blob).not.toMatch(re);
    }
  });

  it('does not contain verbatim CLAUDE.md rule phrases', () => {
    // These phrases are real CLAUDE.md content (verifiable via grep on
    // any branch that has them). The principle bans inlining real
    // user-authored rule text into shipped demos — fictional but
    // plausible is the contract.
    const claudeMdPhrases = [
      'addressed ≠ delivered',
      'Reconcile state before acting',
      'Staging discipline',
      'NEVER use git commands with the -i flag',
    ];
    const blob = ALL_DEMO_CONTENT();
    for (const phrase of claudeMdPhrases) {
      expect(blob).not.toContain(phrase);
    }
  });
});

describe('demoFixtures — shape correctness', () => {
  it('makeDemoWorkshopStatus produces the populated 4-metric demo', () => {
    const ws = makeDemoWorkshopStatus();
    expect(ws.unappliedPatternCount).toBeGreaterThan(0);
    expect(ws.appliedPatternCount).toBeGreaterThan(0);
    expect(ws.recurringAfterApplyCount).toBeGreaterThanOrEqual(0);
    expect(ws.loopClosureRate).not.toBeNull();
    expect(ws.topUnapplied.length).toBeGreaterThan(0);
    expect(ws.recentApplies.length).toBeGreaterThan(0);
  });

  it('each demo CorrectionPattern carries all required fields', () => {
    const ws = makeDemoWorkshopStatus();
    for (const p of ws.topUnapplied) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.canonicalRule).toBe('string');
      expect(p.instanceIds.length).toBeGreaterThan(0);
      expect(p.occurrenceCount).toBeGreaterThan(0);
      expect(typeof p.firstSeen).toBe('number');
      expect(typeof p.lastSeen).toBe('number');
      expect(p.scope.kind).toMatch(/^(global|project|tool|request-shape)$/);
      expect(p.proposedUpgrades.length).toBeGreaterThan(0);
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
      expect(typeof p.recurringPostApplication).toBe('boolean');
      expect(typeof p.alreadyEncoded).toBe('boolean');
    }
  });

  it('makeDemoTopAuditConcerns uses real claimType enum values', () => {
    const real = [
      'fix-claim',
      'tests-pass-claim',
      'build-pass-claim',
      'completion-claim',
      'verification-claim',
      'addition-claim',
    ];
    const concerns = makeDemoTopAuditConcerns();
    expect(concerns.length).toBeGreaterThan(0);
    for (const c of concerns) {
      expect(real).toContain(c.claimType);
      expect(c.sessionId).toContain(DEMO_SID_PREFIX);
    }
  });

  it('makeDemoBlogDraftSlugs returns a mix of final + prompt', () => {
    const slugs = makeDemoBlogDraftSlugs();
    expect(slugs.length).toBeGreaterThan(1);
    const finals = slugs.filter((s) => !s.isPrompt).length;
    const prompts = slugs.filter((s) => s.isPrompt).length;
    expect(finals).toBeGreaterThan(0);
    expect(prompts).toBeGreaterThan(0);
  });
});
