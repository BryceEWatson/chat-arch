// Public surface of @chat-arch/mcp-server.
//
// Phase Rev3-H H1 — package scaffold. H3 will add the actual MCP
// protocol layer + the SDK query tool registrations.

export {
  createMcpServer,
  type CreateMcpServerOptions,
  type McpServerHandle,
  type McpTool,
} from './server.js';

export {
  resolveWorkingDir,
  assertPathWithinWorkingDir,
  WorkingDirError,
  type WorkingDir,
} from './workingDir.js';

export {
  assertReadOnlyTool,
  ReadOnlyPolicyError,
  READ_ONLY_POLICY,
} from './readOnly.js';

export {
  registerSdkTools,
  ToolArgError,
  type RegisterSdkToolsOptions,
} from './tools.js';

export {
  assertLocalhostBind,
  LOCALHOST_BIND_POLICY,
  LocalhostBindError,
  type AssertLocalhostBindInput,
  type BindDescriptor,
} from './localhostBind.js';
