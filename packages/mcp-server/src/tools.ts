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
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolArgError(
      `Tool "${toolName}" requires "${key}" to be a non-empty string. Got: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function requireNumber(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolArgError(
      `Tool "${toolName}" requires "${key}" to be a finite number. Got: ${JSON.stringify(value)}.`,
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
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolArgError(
      `Optional argument "${key}" must be a non-empty string when present. Got: ${JSON.stringify(value)}.`,
    );
  }
  return value;
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
      const filter: ListNarrativesFilter = {};
      const projectId = optionalString(args, 'projectId');
      const sentiment = optionalString(args, 'sentiment');
      const schemaVersion = optionalNumber(args, 'schemaVersion');
      if (projectId !== undefined) (filter as { projectId?: string }).projectId = projectId;
      if (sentiment !== undefined) (filter as { sentiment?: string }).sentiment = sentiment;
      if (schemaVersion !== undefined) (filter as { schemaVersion?: number }).schemaVersion = schemaVersion;
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
      const filter: ListPatternsFilter = {};
      const projectId = optionalString(args, 'projectId');
      const sourceNarrativeId = optionalString(args, 'sourceNarrativeId');
      const appendedToClaudeMd = optionalBoolean(args, 'appendedToClaudeMd');
      if (projectId !== undefined) (filter as { projectId?: string }).projectId = projectId;
      if (sourceNarrativeId !== undefined) (filter as { sourceNarrativeId?: string }).sourceNarrativeId = sourceNarrativeId;
      if (appendedToClaudeMd !== undefined) (filter as { appendedToClaudeMd?: boolean }).appendedToClaudeMd = appendedToClaudeMd;
      return listPatterns(db, filter);
    },
  });

  // ── findings ───────────────────────────────────────────────
  server.registerTool({
    name: 'get_finding',
    description: 'Look up a finding by integer id.',
    handler: async (args) => {
      assertNoUnknownKeys('get_finding', args, ['id']);
      const id = requireNumber('get_finding', args, 'id');
      return getFindingById(db, id);
    },
  });
  server.registerTool({
    name: 'list_findings',
    description:
      'List findings, optionally filtered by kernel / project / topic / narrative / pattern anchors.',
    handler: async (args) => {
      assertNoUnknownKeys('list_findings', args, [
        'kernel',
        'projectId',
        'topicId',
        'narrativeId',
        'patternId',
      ]);
      const filter: FindingsFilter = {};
      const kernel = optionalString(args, 'kernel');
      const projectId = optionalString(args, 'projectId');
      const topicId = optionalString(args, 'topicId');
      const narrativeId = optionalString(args, 'narrativeId');
      const patternId = optionalString(args, 'patternId');
      if (kernel !== undefined) (filter as { kernel?: string }).kernel = kernel;
      if (projectId !== undefined) (filter as { projectId?: string | null }).projectId = projectId;
      if (topicId !== undefined) (filter as { topicId?: string | null }).topicId = topicId;
      if (narrativeId !== undefined) (filter as { narrativeId?: string | null }).narrativeId = narrativeId;
      if (patternId !== undefined) (filter as { patternId?: string | null }).patternId = patternId;
      return listFindings(db, filter);
    },
  });
}

export { ToolArgError };
