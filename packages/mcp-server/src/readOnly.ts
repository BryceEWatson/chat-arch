// Phase Rev3-H H2 — read-only tool surface policy.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase
// Rev3-H H2:
//
//   "Read-only by default; narrow tool surface (no arbitrary
//    readFile, no `claude -p` exec from server, working-dir scoped
//    to chat-arch-data/)."
//
// This module owns ONE pure decision: given a candidate tool name,
// is the verb in the read-only allowlist? Pure policy — no
// I/O, no protocol layer. The server factory (`server.ts`) calls
// `assertReadOnlyTool` at registration time so any caller asking
// for a write-shaped name is rejected before the protocol layer
// even sees it.
//
// The allowlist is positive — every permitted verb is enumerated.
// New tools added in H3 must use one of these verb prefixes; new
// verbs require a deliberate change here (which a reviewer must
// approve).

const READ_VERB_PREFIXES = [
  'get_',
  'list_',
  'query_',
  'search_',
  'count_',
  'describe_',
] as const;

const FORBIDDEN_VERB_PREFIXES = [
  'write_',
  'create_',
  'update_',
  'delete_',
  'remove_',
  'set_',
  'put_',
  'patch_',
  'insert_',
  'upsert_',
  'exec_',
  'run_',
  'spawn_',
  'execute_',
  'eval_',
] as const;

export class ReadOnlyPolicyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'forbidden-verb'
      | 'unknown-verb'
      | 'empty-name'
      | 'invalid-shape',
  ) {
    super(message);
    this.name = 'ReadOnlyPolicyError';
  }
}

/**
 * Validate a candidate tool name against the read-only policy.
 *
 * Rules:
 *   1. Non-empty after trim.
 *   2. Shape: `<verb>_<noun>` (snake_case, ASCII alnum + underscore).
 *   3. Verb prefix MUST be in `READ_VERB_PREFIXES`.
 *   4. Verb prefix MUST NOT be in `FORBIDDEN_VERB_PREFIXES` (a
 *      defense-in-depth check; redundant with rule 3 but catches
 *      future additions that forget to update the allowlist).
 *
 * Throws `ReadOnlyPolicyError` on violation; returns the
 * lowercased / normalized name on success.
 */
export function assertReadOnlyTool(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new ReadOnlyPolicyError(
      'Tool name cannot be empty.',
      'empty-name',
    );
  }
  // Shape: lowercase snake_case (ASCII alnum + underscore, with at
  // least one underscore between verb and noun).
  if (!/^[a-z][a-z0-9_]*_[a-z][a-z0-9_]*$/.test(trimmed)) {
    throw new ReadOnlyPolicyError(
      `Tool name must be lowercase snake_case "<verb>_<noun>". Got: "${name}".`,
      'invalid-shape',
    );
  }
  // Forbidden-verb check first — defense-in-depth.
  const matchedForbidden = FORBIDDEN_VERB_PREFIXES.find((prefix) =>
    trimmed.startsWith(prefix),
  );
  if (matchedForbidden !== undefined) {
    throw new ReadOnlyPolicyError(
      `Tool name "${name}" starts with forbidden write-verb prefix "${matchedForbidden}". MCP server is read-only.`,
      'forbidden-verb',
    );
  }
  const matchedAllowed = READ_VERB_PREFIXES.find((prefix) =>
    trimmed.startsWith(prefix),
  );
  if (matchedAllowed === undefined) {
    throw new ReadOnlyPolicyError(
      `Tool name "${name}" does not start with an allowed read-verb prefix (${READ_VERB_PREFIXES.join(', ')}).`,
      'unknown-verb',
    );
  }
  return trimmed;
}

/**
 * Export the verb sets so reviewers + downstream tests can pin
 * what's allowed without re-deriving the list. Frozen so callers
 * can't mutate the policy at runtime.
 */
export const READ_ONLY_POLICY = Object.freeze({
  readVerbPrefixes: Object.freeze([...READ_VERB_PREFIXES]),
  forbiddenVerbPrefixes: Object.freeze([...FORBIDDEN_VERB_PREFIXES]),
});
