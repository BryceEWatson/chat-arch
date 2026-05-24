// Phase Rev3-H H1 — standalone MCP server scaffold.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase
// Rev3-H H1+H2:
//
//   "Standalone MCP server package under `packages/mcp-server/`."
//   "Read-only by default; narrow tool surface (no arbitrary
//    readFile, no `claude -p` exec from server, working-dir scoped
//    to chat-arch-data/)."
//
// This module owns the SCAFFOLD: a pure factory that takes a
// validated working dir + read-only policy and returns a server
// handle exposing `registerTool` / `listTools` / `close`. The
// actual MCP protocol layer (stdio transport, JSON-RPC, the
// `@modelcontextprotocol/sdk` library) is deferred to Phase
// Rev3-H H3 where the real query tools land — separating the
// protocol layer from the policy layer means the policies are
// testable as pure functions and the H3 protocol wiring has a
// well-defined boundary to plug into.

import {
  assertReadOnlyTool,
  ReadOnlyPolicyError,
} from './readOnly.js';
import {
  resolveWorkingDir,
  type WorkingDir,
} from './workingDir.js';

export interface CreateMcpServerOptions {
  /**
   * Absolute path to the `chat-arch-data/` working directory. Will
   * be validated through `resolveWorkingDir`.
   */
  readonly workingDir: string;
}

/**
 * A registered MCP tool. The handler is opaque to this scaffold —
 * H3 will plug in handlers that wrap `@chat-arch/exporter/db` SDK
 * query methods. For now the scaffold only owns the registration
 * + policy enforcement.
 */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly handler: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

export interface McpServerHandle {
  readonly workingDir: WorkingDir;
  /**
   * Register a new tool. Throws `ReadOnlyPolicyError` if the name
   * violates the read-only allowlist. Throws if a tool with the
   * same name is already registered.
   */
  registerTool(tool: McpTool): void;
  /** Snapshot of all registered tools (frozen). */
  listTools(): readonly McpTool[];
  /**
   * Releases any resources held by the server. For the scaffold
   * this is a no-op; H3 will close DB connections + the MCP
   * transport here.
   */
  close(): Promise<void>;
}

/**
 * Pure factory: validate options, return a server handle with an
 * empty tool registry. H3 will plug the MCP protocol layer on top
 * by calling `registerTool` for each SDK query method.
 */
export function createMcpServer(
  options: CreateMcpServerOptions,
): McpServerHandle {
  const workingDir = resolveWorkingDir(options.workingDir);
  const tools = new Map<string, McpTool>();

  return {
    workingDir,
    registerTool(tool: McpTool): void {
      const normalized = assertReadOnlyTool(tool.name);
      if (tools.has(normalized)) {
        throw new ReadOnlyPolicyError(
          `Tool with name "${normalized}" already registered.`,
          'invalid-shape',
        );
      }
      tools.set(normalized, tool);
    },
    listTools(): readonly McpTool[] {
      return Object.freeze([...tools.values()]);
    },
    close(): Promise<void> {
      tools.clear();
      return Promise.resolve();
    },
  };
}
