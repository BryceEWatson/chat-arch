// Phase Rev3-H H5 — gate test.
//
// Plan exit criterion for Phase Rev3-H:
//   "the same query returns equivalent results in the viewer and
//    from an external claude session."
//
// "Equivalent" pinned operationally as: for every registered MCP
// tool, the value returned from `tool.handler(args)` (which is
// what the protocol layer will serialize and ship to an external
// claude session) MUST deep-equal the value returned by a direct
// `@chat-arch/exporter/db` SDK call against the SAME db handle
// with the SAME arguments. The viewer reads through the SDK; the
// MCP tool reads through the SDK; the wiring contract pinned here
// is that the MCP tool layer adds NO transformation, projection,
// filtering, or coercion — it's a pass-through.
//
// Why a single composition test (not unit tests per tool): each
// SDK method already has its own tests in @chat-arch/exporter. The
// gate here is about the wiring — adding a layer (this MCP server)
// MUST NOT silently mutate semantics. The cheapest way to pin
// that is to seed a known fixture and assert byte-identical
// equivalence across the whole tool surface.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@chat-arch/exporter/db';
import { MIGRATIONS, openDb, runMigrations } from '@chat-arch/exporter/db';
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
  SEED_IDS,
  seedRev3Fixture,
} from '@chat-arch/exporter/db';

import { createMcpServer, type McpServerHandle } from './server.js';
import { registerSdkTools } from './tools.js';

const TMPDIR = process.env['TMPDIR'] ?? process.env['TEMP'] ?? '/tmp';
const WORKING_DIR = `${TMPDIR}/chat-arch-data`;

let db: Database;
let server: McpServerHandle;

beforeAll(async () => {
  // In-memory DB so the gate doesn't touch the developer's local
  // chat-arch-data tree. The DB handle is what both the SDK and
  // the MCP tools share — equivalence is therefore about wiring,
  // not storage.
  db = openDb(':memory:');
  runMigrations(db, MIGRATIONS);
  await seedRev3Fixture(db);
  server = createMcpServer({ workingDir: WORKING_DIR });
  registerSdkTools(server, { db });
});

afterAll(async () => {
  await server.close();
  db.close();
});

interface GateCase {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly sdkCall: () => unknown;
}

describe('Phase Rev3-H H5 — MCP tool ≡ direct SDK call (equivalence gate)', () => {
  describe('get_<entity>(id) — by-id lookups round-trip', () => {
    const cases: readonly GateCase[] = [
      {
        toolName: 'get_project',
        args: { id: SEED_IDS.projects.p1 },
        sdkCall: () => getProjectById(db, SEED_IDS.projects.p1),
      },
      {
        toolName: 'get_topic',
        args: { id: SEED_IDS.topics.t1 },
        sdkCall: () => getTopicById(db, SEED_IDS.topics.t1),
      },
      {
        toolName: 'get_narrative',
        args: { id: Object.values(SEED_IDS.narratives)[0] as string },
        sdkCall: () =>
          getNarrativeById(
            db,
            Object.values(SEED_IDS.narratives)[0] as string,
          ),
      },
      // Pattern + finding ids require running the seed first; we
      // probe via list_* and pick the first id below.
    ];

    it.each(cases)(
      '$toolName: tool result deep-equals direct SDK call',
      async ({ toolName, args, sdkCall }) => {
        const tool = server.listTools().find((t) => t.name === toolName);
        expect(tool).toBeDefined();
        const toolResult = await tool!.handler(args);
        const sdkResult = sdkCall();
        expect(toolResult).toEqual(sdkResult);
        expect(toolResult).not.toBeNull(); // sanity: fixture seeded the row
      },
    );
  });

  describe('list_<entity>() — unfiltered lists round-trip', () => {
    const cases: readonly GateCase[] = [
      {
        toolName: 'list_projects',
        args: {},
        sdkCall: () => listProjects(db),
      },
      {
        toolName: 'list_topics',
        args: {},
        sdkCall: () => listTopics(db),
      },
      {
        toolName: 'list_narratives',
        args: {},
        sdkCall: () => listNarratives(db),
      },
      {
        toolName: 'list_patterns',
        args: {},
        sdkCall: () => listPatterns(db),
      },
      {
        toolName: 'list_findings',
        args: {},
        sdkCall: () => listFindings(db),
      },
    ];

    it.each(cases)(
      '$toolName: tool result deep-equals direct SDK call (no filter)',
      async ({ toolName, args, sdkCall }) => {
        const tool = server.listTools().find((t) => t.name === toolName);
        expect(tool).toBeDefined();
        const toolResult = await tool!.handler(args);
        const sdkResult = sdkCall();
        expect(toolResult).toEqual(sdkResult);
        // Sanity: the seed fixture populates every entity table.
        expect(Array.isArray(toolResult)).toBe(true);
        expect((toolResult as unknown[]).length).toBeGreaterThan(0);
      },
    );
  });

  describe('list_<entity>(filter) — filtered lists round-trip', () => {
    it('list_narratives with projectId filter matches direct SDK call', async () => {
      const projectId = SEED_IDS.projects.p1;
      const tool = server.listTools().find((t) => t.name === 'list_narratives');
      const toolResult = await tool!.handler({ projectId });
      const sdkResult = listNarratives(db, { projectId });
      expect(toolResult).toEqual(sdkResult);
    });

    it('list_patterns with projectId filter matches direct SDK call', async () => {
      const projectId = SEED_IDS.projects.p1;
      const tool = server.listTools().find((t) => t.name === 'list_patterns');
      const toolResult = await tool!.handler({ projectId });
      const sdkResult = listPatterns(db, { projectId });
      expect(toolResult).toEqual(sdkResult);
    });

    it('list_findings with projectId filter matches direct SDK call', async () => {
      const projectId = SEED_IDS.projects.p1;
      const tool = server.listTools().find((t) => t.name === 'list_findings');
      const toolResult = await tool!.handler({ projectId });
      const sdkResult = listFindings(db, { projectId });
      expect(toolResult).toEqual(sdkResult);
    });
  });

  describe('get_pattern + get_finding — by-id lookups via probe', () => {
    it('get_pattern(id) for a seeded pattern matches SDK', async () => {
      const patterns = listPatterns(db);
      expect(patterns.length).toBeGreaterThan(0);
      const id = patterns[0]!.id;
      const tool = server.listTools().find((t) => t.name === 'get_pattern');
      const toolResult = await tool!.handler({ id });
      const sdkResult = getPatternById(db, id);
      expect(toolResult).toEqual(sdkResult);
    });

    it('get_finding(id) for a seeded finding matches SDK', async () => {
      const findings = listFindings(db);
      expect(findings.length).toBeGreaterThan(0);
      const id = findings[0]!.id;
      const tool = server.listTools().find((t) => t.name === 'get_finding');
      const toolResult = await tool!.handler({ id });
      const sdkResult = getFindingById(db, id);
      expect(toolResult).toEqual(sdkResult);
    });
  });

  describe('argument-shape rejections (tools reject unknown / mistyped args)', () => {
    it('get_project rejects unknown key', async () => {
      const tool = server.listTools().find((t) => t.name === 'get_project');
      await expect(
        tool!.handler({ id: 'x', evil: 'value' }),
      ).rejects.toThrow(/unknown argument "evil"/);
    });

    it('get_project rejects missing id', async () => {
      const tool = server.listTools().find((t) => t.name === 'get_project');
      await expect(tool!.handler({})).rejects.toThrow(
        /requires "id" to be a non-empty string/,
      );
    });

    it('get_finding rejects string id (must be number)', async () => {
      const tool = server.listTools().find((t) => t.name === 'get_finding');
      await expect(tool!.handler({ id: 'oops' })).rejects.toThrow(
        /requires "id" to be a finite number/,
      );
    });

    it('list_narratives rejects unknown filter key', async () => {
      const tool = server.listTools().find((t) => t.name === 'list_narratives');
      await expect(
        tool!.handler({ badKey: 'x' }),
      ).rejects.toThrow(/unknown argument "badKey"/);
    });

    it('list_patterns rejects non-boolean appendedToClaudeMd', async () => {
      const tool = server.listTools().find((t) => t.name === 'list_patterns');
      await expect(
        tool!.handler({ appendedToClaudeMd: 'yes' }),
      ).rejects.toThrow(/must be a boolean/);
    });
  });

  describe('tool surface inventory', () => {
    it('registers exactly 10 SDK tools (5 get + 5 list, one per entity)', () => {
      const names = server.listTools().map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'get_finding',
          'get_narrative',
          'get_pattern',
          'get_project',
          'get_topic',
          'list_findings',
          'list_narratives',
          'list_patterns',
          'list_projects',
          'list_topics',
        ].sort(),
      );
    });

    it('all registered tools pass the H2 read-only allowlist (sanity — registerSdkTools depends on the allowlist accepting these names)', () => {
      // The registration would have thrown if any tool name
      // violated the allowlist; the surface inventory above
      // confirms all 10 registered cleanly. This explicit
      // restatement documents the cross-phase dependency for any
      // reviewer scanning H5 in isolation.
      const names = server.listTools().map((t) => t.name);
      for (const n of names) {
        expect(n).toMatch(/^(get|list)_[a-z][a-z0-9_]*$/);
      }
    });
  });
});
