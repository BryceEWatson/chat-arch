/**
 * Pattern entity — output of the "encode as pattern" flow. A Pattern
 * is a narrative the user found load-bearing enough to extract into
 * a reusable rule (typically appended to CLAUDE.md or the project's
 * skill markdown).
 *
 * Rev3-E E1 adds `falsifierStatus` — the falsifier-gating signal that
 * tracks whether a Pattern's underlying claim has been independently
 * verified (Closure C). Three terminal states are possible:
 *
 *   - 'verified'        — the falsifier ran and the claim's evidence
 *                          chain cites real session turns whose content
 *                          actually supports it. This is the default
 *                          target state for newly-encoded patterns once
 *                          the Rev3-F falsifier skill ships.
 *   - 'skipped-by-user' — the user explicitly opted out of falsifier
 *                          gating (via the encode-as-pattern flow's
 *                          override checkbox; E3 scope). The Pattern
 *                          row still ships so the override is auditable.
 *   - 'unavailable'     — the falsifier could not run (no `claude` CLI,
 *                          429 backoff exhausted, sandboxed). Treated
 *                          like 'verified' for surfacing but flagged in
 *                          the audit table so a user can see why the
 *                          gate didn't engage.
 *
 * Optional in this schema bump (Phase Rev3-E E1) — existing rows
 * survive with `falsifierStatus` absent / NULL. The Rev3-F falsifier
 * pipeline populates it on every new encode; pre-Rev3-E patterns stay
 * unflagged.
 */
export type PatternFalsifierStatus =
  | 'verified'
  | 'skipped-by-user'
  | 'unavailable';

export const PATTERN_FALSIFIER_STATUS_VALUES: readonly PatternFalsifierStatus[] = [
  'verified',
  'skipped-by-user',
  'unavailable',
];

export interface Pattern {
  id: string;
  sourceNarrativeId: string;
  projectId: string;
  title: string;
  body: string;
  encodedAt: string;
  appendedToClaudeMd: boolean;
  /**
   * Closure-C falsifier-gating signal (Phase Rev3-E E1). Optional for
   * back-compat with pre-Rev3-E patterns; the Rev3-F falsifier skill
   * populates it on every new encode and the audit table surfaces
   * the value.
   */
  falsifierStatus?: PatternFalsifierStatus;
}
