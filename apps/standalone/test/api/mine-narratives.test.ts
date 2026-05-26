import { describe, expect, it } from 'vitest';
import {
  REQUIRED_HEADER,
  classifyOutcome,
  isLocalOrigin,
  type NarrativeOutcomeProbe,
} from '../../src/pages/api/mine-narratives.js';

const emptyProbe: NarrativeOutcomeProbe = {
  narrativesGeneratedAt: null,
  statusFileStatus: null,
  statusFileError: null,
};

// Mirror of mine-persona.test.ts shape + the narrative-specific
// silent-abort detection (status file === 'complete' AND narratives.json
// generatedAt >= startedAt). The spec's NarrativeOutcomeProbe rule
// requires BOTH gates because narratives.json existed before the skill
// ran (the exporter wrote it), so a stale fresh-timestamp from a
// concurrent rescan would give a false positive.

describe('mine-narratives — CSRF gate', () => {
  it('accepts http://localhost:<any>', () => {
    expect(isLocalOrigin('http://localhost:4324')).toBe(true);
    expect(isLocalOrigin('http://localhost')).toBe(true);
    expect(isLocalOrigin('https://localhost:8443')).toBe(true);
  });

  it('accepts the loopback IPv4 / IPv6 literals', () => {
    expect(isLocalOrigin('http://127.0.0.1')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1:4324')).toBe(true);
    expect(isLocalOrigin('http://[::1]:4324')).toBe(true);
  });

  it('rejects null / empty / whitespace', () => {
    expect(isLocalOrigin(null)).toBe(false);
    expect(isLocalOrigin('')).toBe(false);
    expect(isLocalOrigin('   ')).toBe(false);
  });

  it('rejects non-loopback hostnames', () => {
    expect(isLocalOrigin('http://example.com')).toBe(false);
    expect(isLocalOrigin('http://attacker.localhost.evil.com')).toBe(false);
    expect(isLocalOrigin('http://192.168.1.1')).toBe(false);
  });

  it('rejects non-http(s) protocols', () => {
    expect(isLocalOrigin('file:///etc/passwd')).toBe(false);
    expect(isLocalOrigin('data:text/html,foo')).toBe(false);
    expect(isLocalOrigin('javascript:alert(1)')).toBe(false);
  });

  it('exposes the X-Requested-With header value', () => {
    // Pinned so a rename can't silently 403 the SCAN chain's 6th step.
    expect(REQUIRED_HEADER).toBe('chat-arch-mine-narratives');
  });
});

describe('mine-narratives — classifyOutcome (silent-abort detection)', () => {
  const started = 1_000_000;

  it('reports success when status === "complete" AND narratives.json is fresh', () => {
    const verdict = classifyOutcome(started, 0, null, {
      narrativesGeneratedAt: started + 5_000,
      statusFileStatus: 'complete',
      statusFileError: null,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('reports success at the boundary narrativesGeneratedAt === startedAt', () => {
    const verdict = classifyOutcome(started, 0, null, {
      narrativesGeneratedAt: started,
      statusFileStatus: 'complete',
      statusFileError: null,
    });
    expect(verdict.ok).toBe(true);
  });

  it('reports failure when claude CLI exits non-zero', () => {
    const verdict = classifyOutcome(started, 1, null, {
      narrativesGeneratedAt: started + 5_000,
      statusFileStatus: 'complete',
      statusFileError: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/exited with code 1/);
  });

  it('reports failure when spawn errored', () => {
    const verdict = classifyOutcome(
      started,
      null,
      new Error('ENOENT claude'),
      emptyProbe,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/spawn error: ENOENT claude/);
  });

  it('takes status-file `error` precedence over a fresh narratives.json', () => {
    const verdict = classifyOutcome(started, 0, null, {
      narrativesGeneratedAt: started + 1,
      statusFileStatus: 'error',
      statusFileError: 'narrative-candidates.json missing',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(
      /skill reported error: narrative-candidates\.json missing/,
    );
  });

  it('silent-abort: CLI exits 0 but status file is missing (skill never ran)', () => {
    const verdict = classifyOutcome(started, 0, null, {
      narrativesGeneratedAt: started + 5_000, // a concurrent rescan refreshed this
      statusFileStatus: null,
      statusFileError: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/did not report status: complete/);
    expect(verdict.reason).toMatch(/no skill status file/);
  });

  it('silent-abort: CLI exits 0 and status is mid-flight (e.g. "synthesizing")', () => {
    const verdict = classifyOutcome(started, 0, null, {
      narrativesGeneratedAt: started + 5_000,
      statusFileStatus: 'synthesizing',
      statusFileError: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/did not report status: complete/);
    expect(verdict.reason).toMatch(/last skill status: synthesizing/);
  });

  it('partial-write recovery: status === "complete" but narratives.json is stale', () => {
    // The skill crashed between writing the status file and renaming
    // narratives.json. Treat as failure with a specific reason.
    const verdict = classifyOutcome(started, 0, null, {
      narrativesGeneratedAt: started - 5_000, // older than startedAt
      statusFileStatus: 'complete',
      statusFileError: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/narratives\.json was not refreshed/);
  });

  it('partial-write recovery: status === "complete" but narratives.json is missing', () => {
    const verdict = classifyOutcome(started, 0, null, {
      narrativesGeneratedAt: null,
      statusFileStatus: 'complete',
      statusFileError: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/narratives\.json was not refreshed/);
  });

  // ---- CAS retry path coverage (spec §"Test plan" requirement) ----
  // The skill captures `existingNarrativesGeneratedAt` at Stage 0
  // (Stage 2c per spec) and re-reads before writing. If the rescan
  // refreshes `narratives.json` mid-run, the skill writes
  // `status: 'concurrent-rescan-aborted'` and exits cleanly. Endpoint
  // observability:
  //   - skill writes `status: 'complete'` with skipped[] containing
  //     per-project `concurrent-rescan-aborted` rows; classifyOutcome
  //     should still report `ok: true` (the run completed normally —
  //     skipped projects are part of the normal output shape, not a
  //     failure mode).
  //   - skill writes `status: 'error'` only on unrecoverable error,
  //     not on CAS-aborted projects.
  // This pins both paths.

  it('CAS retry: per-project concurrent-rescan-aborted does NOT fail the overall run', () => {
    // The skill recorded the project's CAS abort in narratives.json's
    // skipped[] field but the overall run completed normally — the
    // status file is `complete` and narratives.json was refreshed
    // (with the skipped[] entry). classifyOutcome only cares about
    // the top-level run outcome; per-project skipped rows are
    // observability, not failure.
    const verdict = classifyOutcome(started, 0, null, {
      narrativesGeneratedAt: started + 5_000,
      statusFileStatus: 'complete',
      statusFileError: null,
    });
    expect(verdict.ok).toBe(true);
  });

  it('CAS retry: skill error on unrecoverable CAS mismatch surfaces as ok=false', () => {
    // If the CAS retry hits an unrecoverable error (e.g., second
    // mismatch + partial-write halt), the skill writes
    // `status: 'error'` with a CAS-related message. The outcome
    // probe surfaces ok=false with the skill's error reason.
    const verdict = classifyOutcome(started, 0, null, {
      narrativesGeneratedAt: started - 1_000, // stale (write never landed)
      statusFileStatus: 'error',
      statusFileError:
        'concurrent rescan abort: CAS mismatched twice; canonical write is rescan',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/skill reported error:.*CAS mismatched/);
  });
});

// ---- Sentiment-polarization rule (spec §"Test plan" requirement) ----
// The Stage 2a sub-agent prompt mandates: never emit `sentiment:
// 'neutral'`; polarize by outcome-majority of supporting sessions and
// DROP the theme on tie. validateNarrative is the downstream
// defense-in-depth: it throws on `sentiment === 'neutral'`. This unit
// suite pins the validator path so a future schema change can't
// silently allow neutral through.

describe('mine-narratives — sentiment-polarization defense-in-depth', () => {
  it('validateNarrative throws on neutral sentiment (drop signal for Stage 2c)', async () => {
    const { validateNarrative, InvalidNarrativeError } = await import(
      '@chat-arch/schema'
    );
    const neutralRow = {
      id: 'narr_llm_proj_x_neutral',
      projectId: 'proj_x',
      sessionIds: ['s1', 's2'],
      sentiment: 'neutral' as const,
      actionType: 'encode-as-pattern' as const,
      title: 'tied-majority theme',
      body: 'body',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      schemaVersion: 2 as const,
      attributedTo: 'llm-derived' as const,
      provenance: { intent: 'i', observation: 'o', inference: 'inf' },
      confidence: 0.5,
      supportingCount: 2,
      contradictingCount: 0,
      verifiedAt: null,
    };
    expect(() => validateNarrative(neutralRow)).toThrow(InvalidNarrativeError);
    expect(() => validateNarrative(neutralRow)).toThrow(/neutral sentiment/);
  });

  it('validateNarrative accepts positive sentiment with matching encode-as-pattern action', async () => {
    const { validateNarrative } = await import('@chat-arch/schema');
    const positiveRow = {
      id: 'narr_llm_proj_x_p',
      projectId: 'proj_x',
      sessionIds: ['s1', 's2'],
      sentiment: 'positive' as const,
      actionType: 'encode-as-pattern' as const,
      title: 't',
      body: 'b',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      schemaVersion: 2 as const,
      attributedTo: 'llm-derived' as const,
      provenance: { intent: 'i', observation: 'o', inference: 'inf' },
      confidence: 0.5,
      supportingCount: 2,
      contradictingCount: 0,
      verifiedAt: null,
    };
    expect(() => validateNarrative(positiveRow)).not.toThrow();
  });

  it('validateNarrative throws on actionType-sentiment mismatch', async () => {
    const { validateNarrative, InvalidNarrativeError } = await import(
      '@chat-arch/schema'
    );
    // Positive sentiment with the corrective-prompt action — Stage 2c
    // stamps the action deterministically from sentiment, but a
    // forged/buggy row could mismatch.
    const mismatch = {
      id: 'narr_llm_proj_x_m',
      projectId: 'proj_x',
      sessionIds: ['s1', 's2'],
      sentiment: 'positive' as const,
      actionType: 'generate-corrective-prompt' as const,
      title: 't',
      body: 'b',
      evidence: [],
      generatedAt: new Date(0).toISOString(),
      schemaVersion: 2 as const,
      attributedTo: 'llm-derived' as const,
      provenance: { intent: 'i', observation: 'o', inference: 'inf' },
      confidence: 0.5,
      supportingCount: 2,
      contradictingCount: 0,
      verifiedAt: null,
    };
    expect(() => validateNarrative(mismatch)).toThrow(InvalidNarrativeError);
    expect(() => validateNarrative(mismatch)).toThrow(/actionType.*mismatches/);
  });
});
