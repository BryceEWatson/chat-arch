/**
 * F-layer audit configuration — spec §5 F.4.
 *
 * All claim patterns and verifier windows live here so tuning does not
 * require code edits. Patterns match against assistant message bodies
 * (already extracted from transcripts; see auditClaims.ts for the I/O
 * shell). Verifier windows + bump-rules live alongside so the F.2
 * verifier (Wave 3) has a single source of truth.
 *
 * History:
 *   1 — initial regex set + default windows (spec §5 F.1 table).
 */

import type { ClaimType } from '@chat-arch/schema';

export const AUDIT_CONFIG_VERSION = 1;

export interface ClaimPattern {
  claimType: ClaimType;
  /** Case-insensitive. */
  regex: RegExp;
}

/**
 * The six claim families from spec §5 F.1 table. Regexes are intentionally
 * looser than the table prose — recall over precision — so the verifier
 * has cases to verify; the verifier's `inconclusive` outcome handles
 * the over-matched ones.
 */
export const CLAIM_PATTERNS: readonly ClaimPattern[] = [
  {
    claimType: 'fix-claim',
    regex: /\b(?:I |I[''']?ve |Just )?(fixed|resolved|patched|repaired)\b/i,
  },
  {
    // Tolerates qualifiers ("all 234 tests pass", "every test passed cleanly")
    // and bare forms ("tests pass", "tests are passing").
    claimType: 'tests-pass-claim',
    regex: /\b(?:all\b|every\b)?\s*(?:\d+\s+)?tests?\s+(?:are\s+)?(?:now\s+)?(?:pass|passed|passing|passes)\b/i,
  },
  {
    // Permits up to 3 intermediate tokens between the verb and "works"
    // ("verified that this works", "tested that the fix works").
    claimType: 'verification-claim',
    regex: /\b(?:verified|confirmed|tested)\b(?:\s+\S+){0,4}\s+works?\b/i,
  },
  {
    // Allows up to 2 adjectives between the article and the noun
    // ("implemented the missing function", "added a helper").
    claimType: 'addition-claim',
    regex: /\b(?:added|implemented|wrote)\s+(?:a\s+|an\s+|the\s+|new\s+)?(?:\w+\s+){0,2}(?:tests?|functions?|modules?|features?|helpers?|hooks?|components?|methods?|classes|class)\b/i,
  },
  {
    claimType: 'build-pass-claim',
    regex: /\bbuild (?:passes|passed|succeeds|succeeded|is green)\b/i,
  },
  {
    claimType: 'completion-claim',
    regex: /\bnothing (?:else )?(?:to|left to) (?:change|do|update|fix)\b/i,
  },
];

export interface VerifierWindows {
  /** For fix-claim — forward window in assistant messages. */
  fixWindow: number;
  /** For tests-pass — forward window. */
  testsWindow: number;
  /** For build-pass — forward window. */
  buildWindow: number;
  /** For verification-claim — forward window (any tool use suffices). */
  verificationWindow: number;
  /** For addition-claim — forward window. */
  additionWindow: number;
  /** For completion-claim — forward window over user messages for pushback. */
  completionWindow: number;
}

export const DEFAULT_VERIFIER_WINDOWS: VerifierWindows = {
  fixWindow: 20,
  testsWindow: 20,
  buildWindow: 20,
  verificationWindow: 10,
  additionWindow: 20,
  completionWindow: 30,
};

/**
 * Common pushback regexes used by the completion-claim verifier (F.2,
 * Wave 3). Living here so the verifier and the F.1 extractor stay
 * configurable from one file.
 */
export const PUSHBACK_PATTERNS: readonly RegExp[] = [
  /\b(?:but|however) .* (?:still|isn'?t|broken|wrong|fail(?:s|ed|ing)?)\b/i,
  /\b(?:didn'?t|did not) work\b/i,
  /\bthat'?s (?:still )?(?:wrong|broken|incorrect|failing)\b/i,
  /\b(?:no|nope), (?:still|that)\b/i,
];

/**
 * How many characters of surrounding assistant text to attach to each
 * extracted claim. Keep small — the audit-claims.json sidecar grows
 * linearly with this and the user only needs enough context to judge
 * "did the claim happen here or am I misreading the regex hit".
 */
export const SURROUNDING_CONTEXT_CHARS = 400;
