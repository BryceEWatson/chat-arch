// Phase Rev3-H H3 — wire @chat-arch/exporter/db SDK query methods
// as MCP tools.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase
// Rev3-H H3:
//
//   "Expose data SDK query methods as MCP tools (projects, topics,
//    narratives, patterns, findings)."
//
// Each tool wraps exactly one SDK call: `get_<entity>` for the
// by-id lookup, `list_<entity>` for the filtered/unfiltered list.
// The handler:
//   1. Validates the argument shape (minimal hand-rolled; the
//      protocol layer plugs in proper JSON-Schema validation
//      later when @modelcontextprotocol/sdk is wired).
//   2. Invokes the SDK with the captured `db` handle.
//   3. Returns the rows directly (better-sqlite3 already returns
//      plain objects).
//
// All 10 tool names pass the H2 read-only allowlist by
// construction (`get_` / `list_` prefixes + single-segment nouns
// with no embedded write verbs). The server factory's
// `registerTool` enforces this at runtime regardless.

import type {
  Database,
  ListNarrativesFilter,
  ListPatternsFilter,
  FindingsFilter,
  SessionKey,
} from '@chat-arch/exporter/db';
import {
  getFindingById,
  getNarrativeById,
  getPatternById,
  getProjectById,
  getTopicById,
  listFindings,
  listNarratives,
  listPatterns,
  listProjects,
  listTopics,
} from '@chat-arch/exporter/db';

import type { McpServerHandle } from './server.js';

// ─── argument-shape validators ──────────────────────────────────
// Hand-rolled; the protocol layer (H3 protocol-PR / future) will
// likely swap to JSON-Schema. For now the validators reject any
// unknown key + enforce primitive types. Each throws with a clear
// message so a misuse from an external claude session surfaces
// in the protocol response rather than silently coercing.

class ToolArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgError';
  }
}

function assertNoUnknownKeys(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ToolArgError(
        `Tool "${toolName}" got unknown argument "${key}". Allowed: ${allowed.join(', ') || '(none)'}.`,
      );
    }
  }
}

function requireString(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = args[key];
  // `.trim().length === 0` (not `.length === 0`) so whitespace-only
  // strings like `'   '` are rejected. Pre-guard: LLM callers
  // sending `{id: '   '}` reached the SDK as a literal non-empty
  // SQL parameter and got silent empty results. Per final exit-
  // review on rev3-start..main.
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolArgError(
      `Tool "${toolName}" requires "${key}" to be a non-empty string. Got: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Validator for positive-integer SQL rowid lookups. Rejects
 * non-integers, zero, and negatives — better-sqlite3 would
 * silently coerce them to a null lookup, hiding LLM-caller
 * misuse. Per adversarial review on PR #94.
 */
function requirePositiveInteger(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ToolArgError(
      `Tool "${toolName}" requires "${key}" to be a positive integer (≥ 1). Got: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function optionalString(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolArgError(
      `Optional argument "${key}" must be a non-empty string when present. Got: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Like `optionalString`, but also accepts `null` (matches the
 * SDK's `string | null` anchor-filter shape, where `null` means
 * "find rows where this anchor IS NULL"). Per design-coherence +
 * adversarial review on PR #94: the SDK exposes a 3-state filter
 * (undefined/null/string) and the tool layer must mirror it or
 * leak the "find unanchored rows" query path.
 */
function optionalStringOrNull(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolArgError(
      `Optional argument "${key}" must be null or a non-empty string when present. Got: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Optional session-key validator. The SDK's `FindingsFilter.session`
 * accepts `undefined` (don't filter), `null` (find unanchored
 * findings), or `{source, id}` (find findings for that session).
 */
function optionalSessionKey(
  args: Readonly<Record<string, unknown>>,
  key: string,
): SessionKey | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolArgError(
      `Optional argument "${key}" must be null or an object {source, id} when present. Got: ${JSON.stringify(value)}.`,
    );
  }
  const v = value as Record<string, unknown>;
  if (typeof v['source'] !== 'string' || (v['source'] as string).length === 0) {
    throw new ToolArgError(
      `Argument "${key}.source" must be a non-empty string. Got: ${JSON.stringify(v['source'])}.`,
    );
  }
  if (typeof v['id'] !== 'string' || (v['id'] as string).length === 0) {
    throw new ToolArgError(
      `Argument "${key}.id" must be a non-empty string. Got: ${JSON.stringify(v['id'])}.`,
    );
  }
  // Reject extra keys for symmetry with assertNoUnknownKeys.
  for (const k of Object.keys(v)) {
    if (k !== 'source' && k !== 'id') {
      throw new ToolArgError(
        `Argument "${key}" has unknown sub-key "${k}". Allowed: source, id.`,
      );
    }
  }
  return { source: v['source'] as string, id: v['id'] as string };
}

function optionalNumber(
  args: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolArgError(
      `Optional argument "${key}" must be a finite number when present. Got: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function optionalBoolean(
  args: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolArgError(
      `Optional argument "${key}" must be a boolean when present. Got: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

// ─── public surface ─────────────────────────────────────────────

export interface RegisterSdkToolsOptions {
  /** Open SQLite database handle from `@chat-arch/exporter/db`. */
  readonly db: Database;
}

/**
 * Register all 10 SDK query tools on a server handle.
 *
 * Idempotency: callers must register tools on a fresh server. If
 * any of these names are already registered, the underlying
 * `registerTool` throws a `ReadOnlyPolicyError` with code
 * `'invalid-shape'`. The contract is "register-once-per-server".
 *
 * Tool names + arg shapes:
 *
 *   - `get_project`   { id: string }
 *   - `list_projects` { }
 *   - `get_topic`     { id: string }
 *   - `list_topics`   { }
 *   - `get_narrative` { id: string }
 *   - `list_narratives` { projectId?: string, sentiment?: string,
 *                          schemaVersion?: number }
 *   - `get_pattern`   { id: string }
 *   - `list_patterns` { projectId?: string,
 *                          sourceNarrativeId?: string,
 *                          appendedToClaudeMd?: boolean }
 *   - `get_finding`   { id: number }
 *   - `list_findings` { kernel?: string, projectId?: string,
 *                          topicId?: string, narrativeId?: string,
 *                          patternId?: string }
 */
export function registerSdkTools(
  server: McpServerHandle,
  { db }: RegisterSdkToolsOptions,
): void {
  // ── projects ───────────────────────────────────────────────
  server.registerTool({
    name: 'get_project',
    description: 'Look up a project by id.',
    handler: async (args) => {
      assertNoUnknownKeys('get_project', args, ['id']);
      const id = requireString('get_project', args, 'id');
      return getProjectById(db, id);
    },
  });
  server.registerTool({
    name: 'list_projects',
    description: 'List all projects.',
    handler: async (args) => {
      assertNoUnknownKeys('list_projects', args, []);
      return listProjects(db);
    },
  });

  // ── topics ─────────────────────────────────────────────────
  server.registerTool({
    name: 'get_topic',
    description: 'Look up a topic by id.',
    handler: async (args) => {
      assertNoUnknownKeys('get_topic', args, ['id']);
      const id = requireString('get_topic', args, 'id');
      return getTopicById(db, id);
    },
  });
  server.registerTool({
    name: 'list_topics',
    description: 'List all topics.',
    handler: async (args) => {
      assertNoUnknownKeys('list_topics', args, []);
      return listTopics(db);
    },
  });

  // ── narratives ─────────────────────────────────────────────
  server.registerTool({
    name: 'get_narrative',
    description: 'Look up a narrative by id.',
    handler: async (args) => {
      assertNoUnknownKeys('get_narrative', args, ['id']);
      const id = requireString('get_narrative', args, 'id');
      return getNarrativeById(db, id);
    },
  });
  server.registerTool({
    name: 'list_narratives',
    description:
      'List narratives, optionally filtered by project / sentiment / schemaVersion.',
    handler: async (args) => {
      assertNoUnknownKeys('list_narratives', args, [
        'projectId',
        'sentiment',
        'schemaVersion',
      ]);
      const projectId = optionalString(args, 'projectId');
      const sentiment = optionalString(args, 'sentiment');
      const schemaVersion = optionalNumber(args, 'schemaVersion');
      // Spread-conditional builder — each filter key is type-
      // checked against ListNarrativesFilter directly, so a future
      // SDK rename trips TypeScript instead of silently returning
      // unfiltered rows. Per adversarial + simplicity review on
      // PR #94.
      const filter: ListNarrativesFilter = {
        ...(projectId !== undefined && { projectId }),
        ...(sentiment !== undefined && { sentiment }),
        ...(schemaVersion !== undefined && { schemaVersion }),
      };
      return listNarratives(db, filter);
    },
  });

  // ── patterns ───────────────────────────────────────────────
  server.registerTool({
    name: 'get_pattern',
    description: 'Look up a pattern by id.',
    handler: async (args) => {
      assertNoUnknownKeys('get_pattern', args, ['id']);
      const id = requireString('get_pattern', args, 'id');
      return getPatternById(db, id);
    },
  });
  server.registerTool({
    name: 'list_patterns',
    description:
      'List patterns, optionally filtered by project / source-narrative / appended-to-CLAUDE.md flag.',
    handler: async (args) => {
      assertNoUnknownKeys('list_patterns', args, [
        'projectId',
        'sourceNarrativeId',
        'appendedToClaudeMd',
      ]);
      const projectId = optionalString(args, 'projectId');
      const sourceNarrativeId = optionalString(args, 'sourceNarrativeId');
      const appendedToClaudeMd = optionalBoolean(args, 'appendedToClaudeMd');
      const filter: ListPatternsFilter = {
        ...(projectId !== undefined && { projectId }),
        ...(sourceNarrativeId !== undefined && { sourceNarrativeId }),
        ...(appendedToClaudeMd !== undefined && { appendedToClaudeMd }),
      };
      return listPatterns(db, filter);
    },
  });

  // ── findings ───────────────────────────────────────────────
  server.registerTool({
    name: 'get_finding',
    description:
      'Look up a finding by positive-integer rowid.',
    handler: async (args) => {
      assertNoUnknownKeys('get_finding', args, ['id']);
      // Positive integer (not just finite number) — better-sqlite3
      // would silently coerce 1.5 / -1 / 0 to a null rowid lookup,
      // hiding LLM-caller misuse. Per adversarial review on PR #94.
      const id = requirePositiveInteger('get_finding', args, 'id');
      return getFindingById(db, id);
    },
  });
  server.registerTool({
    name: 'list_findings',
    description:
      'List findings, optionally filtered by kernel / project / topic / narrative / pattern anchors (each anchor accepts null to find unanchored rows) / session ({source, id} or null for unanchored).',
    handler: async (args) => {
      assertNoUnknownKeys('list_findings', args, [
        'kernel',
        'projectId',
        'topicId',
        'narrativeId',
        'patternId',
        'session',
      ]);
      const kernel = optionalString(args, 'kernel');
      // Each anchor key is `string | null | undefined` per the
      // SDK's FindingsFilter contract — null finds rows where
      // that anchor IS NULL ("unanchored" query path). Per
      // design-coherence review on PR #94: dropping the null
      // branch made the unanchored path unreachable through MCP.
      const projectId = optionalStringOrNull(args, 'projectId');
      const topicId = optionalStringOrNull(args, 'topicId');
      const narrativeId = optionalStringOrNull(args, 'narrativeId');
      const patternId = optionalStringOrNull(args, 'patternId');
      const session = optionalSessionKey(args, 'session');
      const filter: FindingsFilter = {
        ...(kernel !== undefined && { kernel }),
        ...(projectId !== undefined && { projectId }),
        ...(topicId !== undefined && { topicId }),
        ...(narrativeId !== undefined && { narrativeId }),
        ...(patternId !== undefined && { patternId }),
        ...(session !== undefined && { session }),
      };
      return listFindings(db, filter);
    },
  });
}

export { ToolArgError };
