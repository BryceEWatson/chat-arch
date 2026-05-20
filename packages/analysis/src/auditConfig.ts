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
 *   2 — Phase 1 Wave 2 outcome-substrate families:
 *       gh-pr-(opened|merged|closed-unmerged), git-(revert|reset-hard|
 *       force-push), affirmation. Adds AFFIRMATION_PATTERNS as the
 *       positive-polarity mirror of PUSHBACK_PATTERNS.
 */

import type { ClaimType } from '@chat-arch/schema';

export const AUDIT_CONFIG_VERSION = 2;

export interface ClaimPattern {
  claimType: ClaimType;
  /** Case-insensitive. */
  regex: RegExp;
}

/**
 * Claim families.
 *
 * The first six (spec §5 F.1 table) match assistant message bodies; the
 * outcome-substrate families added in v2 match assistant phrasings that
 * *announce* a git/gh action — the verifier then confirms by inspecting
 * the structured `TimelineEvent` stream (a Bash `tool_use` whose
 * input.command matches `gh pr (create|merge|close)` or `git (revert|
 * reset --hard|push.*--force)`, followed by a `tool_result.isError ===
 * false`). Regexes are intentionally looser than the table prose —
 * recall over precision — so the verifier has cases to verify; the
 * verifier's `inconclusive` outcome handles the over-matched ones.
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
  // ---- v2 outcome-substrate families ----
  {
    // "opened a PR", "created the pull request", "I'll open a PR" — the
    // verifier confirms via a `gh pr create` Bash tool_use.
    claimType: 'gh-pr-opened',
    regex: /\b(?:open(?:ed|ing)?|creat(?:ed|ing)?|filed?|submitt(?:ed|ing))\s+(?:a\s+|the\s+|new\s+)?(?:pr\b|pull[\s-]?request\b)/i,
  },
  {
    // "merged the PR", "PR is merged", "squash-merged" — verifier looks
    // for `gh pr merge`.
    claimType: 'gh-pr-merged',
    regex: /\b(?:(?:squash[-\s])?merg(?:ed|ing)\s+(?:the\s+|that\s+|this\s+|a\s+|my\s+)?(?:pr\b|pull[\s-]?request\b))|(?:\b(?:pr|pull[\s-]?request)\s+(?:is\s+|was\s+|has been\s+)?merged\b)/i,
  },
  {
    // "closed the PR without merging", "abandoned the PR" — verifier
    // looks for `gh pr close`.
    claimType: 'gh-pr-closed-unmerged',
    regex: /\b(?:clos(?:ed|ing)|abandon(?:ed|ing)?|discard(?:ed|ing)?)\s+(?:the\s+|that\s+|this\s+|a\s+|my\s+)?(?:pr\b|pull[\s-]?request\b)(?:\s+(?:without|un)[-\s]?merg(?:ed|ing)?)?/i,
  },
  {
    // "reverted the commit", "I'll revert" — verifier looks for `git revert`.
    claimType: 'git-revert',
    regex: /\b(?:revert(?:ed|ing)?)\s+(?:that\s+|the\s+|this\s+|my\s+)?(?:commit|change|change-?set|patch|merge)?/i,
  },
  {
    // "reset --hard", "hard reset to main" — verifier looks for `git reset --hard`.
    claimType: 'git-reset-hard',
    regex: /\b(?:hard[-\s]?reset|reset\s+--hard|reset\s+hard)\b/i,
  },
  {
    // "force-pushed", "I'll force push" — verifier looks for `git push --force`.
    claimType: 'git-force-push',
    regex: /\b(?:force[-\s]?push(?:ed|ing)?|push(?:ed|ing)?\s+(?:with\s+)?--?force(?:-with-lease)?)\b/i,
  },
  {
    // Positive-polarity mirror of completion-claim. Verified by scanning
    // the NEXT user turn(s) for AFFIRMATION_PATTERNS. The assistant
    // typically signals "ready for sign-off" with phrases like "ready
    // for review" or "let me know how this looks".
    claimType: 'affirmation',
    regex: /\b(?:ready\s+for\s+(?:review|sign[-\s]?off)|let\s+me\s+know\s+(?:how|if)\s+(?:this|that)\s+(?:looks|works)|how\s+does\s+(?:this|that)\s+look\b)/i,
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
  // ---- v2 outcome-substrate windows ----
  /** For gh-pr-(opened|merged|closed-unmerged) — forward window in events. */
  ghPrOpenedWindow: number;
  ghPrMergedWindow: number;
  ghPrClosedUnmergedWindow: number;
  /** For git-(revert|reset-hard|force-push) — forward window in events. */
  gitRevertWindow: number;
  gitResetHardWindow: number;
  gitForcePushWindow: number;
  /** For affirmation — forward window over USER messages. */
  affirmationWindow: number;
}

export const DEFAULT_VERIFIER_WINDOWS: VerifierWindows = {
  fixWindow: 20,
  testsWindow: 20,
  buildWindow: 20,
  verificationWindow: 10,
  additionWindow: 20,
  completionWindow: 30,
  // v2: gh / git verifiers anchor on a Bash tool_use in the forward
  // event window. PRs are announced earlier than they're opened (the
  // assistant says "let me open a PR" then runs the command a few
  // events later), so the window matches the hard verifiers.
  ghPrOpenedWindow: 20,
  ghPrMergedWindow: 20,
  ghPrClosedUnmergedWindow: 20,
  gitRevertWindow: 20,
  gitResetHardWindow: 20,
  gitForcePushWindow: 20,
  // Affirmation mirrors completionWindow — scans next-N user turns.
  affirmationWindow: 30,
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
 * Positive-polarity mirror of PUSHBACK_PATTERNS used by the
 * affirmation-claim verifier (v2). A match on any of these in the user's
 * next turn(s) within `affirmationWindow` is treated as a pass.
 *
 * The patterns are explicit signals of approval — short tokens like "ok"
 * or "yes" are intentionally excluded because they're high-frequency
 * filler in continuation prompts and would over-match.
 */
export const AFFIRMATION_PATTERNS: readonly RegExp[] = [
  /\bperfect\b/i,
  /\bship\s+it\b/i,
  /\bexactly\b/i,
  /\bthat\s+worked\b/i,
  /\blooks\s+good\b/i,
  /\bgreat\s+work\b/i,
  /✓/, // U+2713 check mark
];

/**
 * How many characters of surrounding assistant text to attach to each
 * extracted claim. Keep small — the audit-claims.json sidecar grows
 * linearly with this and the user only needs enough context to judge
 * "did the claim happen here or am I misreading the regex hit".
 */
export const SURROUNDING_CONTEXT_CHARS = 400;
