/** Typed Cowork manifest — only fields we've observed and care about. */
export interface CoworkManifestKnown {
  sessionId: string;
  processName: string;
  cliSessionId?: string;
  cwd: string;
  userSelectedFolders: readonly string[];
  createdAt: number;
  lastActivityAt: number;
  model: string;
  isArchived: boolean;
  title: string;
  vmProcessName: string;
  initialMessage: string;
  slashCommands?: readonly string[];
  enabledMcpTools: Readonly<Record<string, unknown>>;
  remoteMcpServersConfig: readonly Record<string, unknown>[];
  egressAllowedDomains: readonly string[];
  systemPrompt: string;
  accountName: string;
  emailAddress: string;
  userApprovedFileAccessPaths?: readonly string[];
  mcqAnswers?: Readonly<Record<string, unknown>>;
  hostLoopMode?: boolean;
  orgCliExecPolicies?: Readonly<Record<string, unknown>>;
  memoryEnabled?: boolean;
  scheduledTaskId?: string;
  sessionType?: 'scheduled' | 'interactive' | string;
  error?: string;
}

/** JSON parser output — tolerant of unknown forward-compat keys. */
export type CoworkManifestRaw = CoworkManifestKnown & Record<string, unknown>;

/** Common fields on every audit.jsonl event. */
export interface CoworkAuditLineBase {
  type: string;
  uuid?: string;
  session_id?: string;
  _audit_timestamp: string; // ISO-8601
  _audit_hmac?: string; // present on newer sessions
}

export interface CoworkUserLine extends CoworkAuditLineBase {
  type: 'user';
  parent_tool_use_id: string | null;
  message: unknown;
}

export interface CoworkAssistantLine extends CoworkAuditLineBase {
  type: 'assistant';
  parent_tool_use_id: string | null;
  message: unknown;
}

/** system lines have subtypes; discriminate on `subtype`. */
export interface CoworkSystemInitLine extends CoworkAuditLineBase {
  type: 'system';
  subtype: 'init';
  agents?: unknown;
  apiKeySource?: string;
  claude_code_version?: string;
  cwd?: string;
  fast_mode_state?: unknown;
  mcp_servers?: unknown;
  model?: string;
  output_style?: string;
  permissionMode?: string;
  plugins?: unknown;
  skills?: unknown;
  slash_commands?: unknown;
  tools?: unknown;
}

export interface CoworkSystemHookLine extends CoworkAuditLineBase {
  type: 'system';
  subtype: 'hook';
  hook_event: string;
  hook_id: string;
  hook_name: string;
}

/** Tolerant arm for unknown/forward-compat subtypes. */
export interface CoworkSystemUnknownSubtypeLine extends CoworkAuditLineBase {
  type: 'system';
  subtype: Exclude<string, 'init' | 'hook'>;
  [k: string]: unknown;
}

export type CoworkSystemLine =
  | CoworkSystemInitLine
  | CoworkSystemHookLine
  | CoworkSystemUnknownSubtypeLine;

export interface CoworkToolUseSummaryLine extends CoworkAuditLineBase {
  type: 'tool_use_summary';
  preceding_tool_use_ids: readonly string[];
  summary: string;
}

export interface CoworkRateLimitLine extends CoworkAuditLineBase {
  type: 'rate_limit_event';
  rate_limit_info: unknown;
}

/** The cost/duration rollup. NOT GUARANTEED to appear (see CONTRADICTIONS C5). */
export interface CoworkResultLine extends CoworkAuditLineBase {
  type: 'result';
  subtype: 'success' | 'error' | string;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: Readonly<Record<string, unknown>>;
  modelUsage: Readonly<Record<string, unknown>>;
  permission_denials: readonly unknown[];
}

/** Tolerant fallback for unknown/evolving line types. */
export interface CoworkUnknownLine extends CoworkAuditLineBase {
  type: string;
  [k: string]: unknown;
}

export type CoworkAuditLine =
  | CoworkUserLine
  | CoworkAssistantLine
  | CoworkSystemLine
  | CoworkToolUseSummaryLine
  | CoworkRateLimitLine
  | CoworkResultLine
  | CoworkUnknownLine;

/** Desktop-CLI manifest — different shape from Cowork manifest. */
export interface DesktopCliManifestKnown {
  sessionId: string;
  cliSessionId: string;
  cwd: string;
  originCwd: string;
  createdAt: number;
  lastActivityAt: number;
  model: string;
  effort: string;
  isArchived: boolean;
  title: string;
  titleSource: 'auto' | string;
  permissionMode: string;
  chromePermissionMode: string;
  enabledMcpTools: Readonly<Record<string, unknown>>;
  remoteMcpServersConfig: readonly Record<string, unknown>[];
}

export type DesktopCliManifestRaw = DesktopCliManifestKnown & Record<string, unknown>;
