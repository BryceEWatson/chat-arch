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

// Allowlisted read-verb prefixes. The first two (`get_`, `list_`)
// mirror the @chat-arch/exporter/db SDK's actual method naming
// (getSessionByKey, listProjects, etc.) — those are the verbs
// H3 will use for its tool registrations. The remaining four
// (`query_`, `search_`, `count_`, `describe_`) are aspirational —
// they're standard MCP idioms that future SDK methods MAY adopt.
// Listed here so reviewers don't have to debate the policy at
// registration time; trimmed if H3 doesn't need them.
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

// Verb ROOTS (no trailing underscore) used by the segment-scan
// check. Adversarial review surfaced that a name starting with a
// read-verb (e.g. `list_`) but EMBEDDING a write-verb later in the
// name — `list_then_delete_project`, `get_delete_all`,
// `list_run_migration` — would pass the prefix-only forbidden
// check. The segment scan catches it by tokenizing on `_` and
// rejecting any segment whose value is a known write-verb root.
const FORBIDDEN_VERB_ROOTS: ReadonlySet<string> = new Set(
  FORBIDDEN_VERB_PREFIXES.map((prefix) => prefix.slice(0, -1)),
);

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
 *   4. NO segment in the name (split on `_`) may match a forbidden
 *      verb root. This catches the EMBEDDED-write-verb attack
 *      (e.g. `list_then_delete_project` would pass rule 3 because
 *      it starts with `list_` but contains `delete` as an embedded
 *      segment). Per adversarial review on PR #93.
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
  // Segment-scan: tokenize on `_` and reject if ANY segment is a
  // known write-verb root. Catches both `delete_project` (prefix)
  // and `list_then_delete_project` (embedded).
  const segments = trimmed.split('_');
  const embeddedForbidden = segments.find((seg) =>
    FORBIDDEN_VERB_ROOTS.has(seg),
  );
  if (embeddedForbidden !== undefined) {
    throw new ReadOnlyPolicyError(
      `Tool name "${name}" contains forbidden write-verb segment "${embeddedForbidden}". MCP server is read-only — no write verbs allowed in any segment of the name.`,
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
