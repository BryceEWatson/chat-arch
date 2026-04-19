/** Common fields on event-shaped CLI transcript lines. */
export interface CliEventBase {
  type: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string; // ISO-8601; absent on some non-event types like ai-title
  cwd?: string;
  gitBranch?: string | null;
  isSidechain?: boolean;
  permissionMode?: string;
  promptId?: string;
  entrypoint?: string; // absent on older transcripts
  userType?: 'external' | string;
  version?: string;
}

export interface CliUserLine extends CliEventBase {
  type: 'user';
  message: unknown;
}

export interface CliAssistantLine extends CliEventBase {
  type: 'assistant';
  requestId?: string;
  message: {
    id?: string;
    type?: 'message';
    role?: 'assistant';
    model?: string;
    content?: readonly unknown[];
    stop_reason?: string | null;
    stop_sequence?: string | null;
    stop_details?: unknown;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
      server_tool_use?: unknown;
      service_tier?: string;
      cache_creation?: unknown;
      inference_geo?: string;
      iterations?: readonly unknown[];
      speed?: string;
    };
  };
}

export interface CliAttachmentLine extends CliEventBase {
  type: 'attachment';
  attachment: unknown;
}

export interface CliProgressLine {
  type: 'progress';
  data?: unknown;
  toolUseID?: string;
  parentToolUseID?: string;
  slug?: string;
}

export interface CliFileHistorySnapshotLine {
  type: 'file-history-snapshot';
  snapshot: unknown;
  messageId: string;
  isSnapshotUpdate: boolean;
}

export interface CliQueueOperationLine {
  type: 'queue-operation';
  operation: string;
  sessionId: string;
  timestamp: string;
  content?: string;
}

export interface CliLastPromptLine {
  type: 'last-prompt';
  lastPrompt: string;
  sessionId: string;
}

/** The primary title source. */
export interface CliAiTitleLine {
  type: 'ai-title';
  aiTitle: string;
  sessionId: string;
}

/** Tolerant fallback. */
export interface CliUnknownLine {
  type: string;
  [k: string]: unknown;
}

export type CliTranscriptLine =
  | CliUserLine
  | CliAssistantLine
  | CliAttachmentLine
  | CliProgressLine
  | CliFileHistorySnapshotLine
  | CliQueueOperationLine
  | CliLastPromptLine
  | CliAiTitleLine
  | CliUnknownLine;
