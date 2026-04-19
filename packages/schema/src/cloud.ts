/** Top-level of conversations.json. */
export interface CloudConversation {
  uuid: string;
  name: string;
  summary: string;
  created_at: string;
  updated_at: string;
  account: { uuid: string };
  chat_messages: readonly CloudMessage[];
}

/** A single message in chat_messages. */
export interface CloudMessage {
  uuid: string;
  parent_message_uuid: string;
  sender: 'human' | 'assistant' | string;
  text: string;
  content: readonly CloudContentBlock[];
  created_at: string;
  updated_at: string;
  attachments: readonly CloudAttachment[];
  files: readonly CloudFileRef[];
}

/** Content block union. */
export type CloudContentBlock =
  | CloudTextBlock
  | CloudThinkingBlock
  | CloudToolUseBlock
  | CloudToolResultBlock
  | CloudTokenBudgetBlock
  | CloudUnknownBlock;

export interface CloudTextBlock {
  type: 'text';
  text: string;
}

export interface CloudThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  summaries?: readonly unknown[];
  cut_off?: boolean;
  truncated?: boolean;
  start_timestamp?: string;
  stop_timestamp?: string;
  alternative_display_type?: string;
  flags?: unknown;
}

export interface CloudToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  display_content?: unknown;
  flags?: unknown;
  integration_name?: string;
  integration_icon_url?: string;
  is_mcp_app?: boolean;
  mcp_server_url?: string;
  message?: unknown;
  icon_name?: string;
  start_timestamp?: string;
  stop_timestamp?: string;
  approval_key?: string;
  approval_options?: unknown;
  context?: unknown;
}

export interface CloudToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: readonly unknown[];
  display_content?: unknown;
  flags?: unknown;
  icon_name?: string;
  integration_icon_url?: string;
  integration_name?: string;
  is_error?: boolean;
  mcp_server_url?: string;
  message?: unknown;
  meta?: unknown;
  name?: string;
  start_timestamp?: string;
  stop_timestamp?: string;
  structured_content?: unknown;
}

export interface CloudTokenBudgetBlock {
  type: 'token_budget';
  [k: string]: unknown;
}

export interface CloudUnknownBlock {
  type: string;
  [k: string]: unknown;
}

export interface CloudAttachment {
  file_name: string;
  file_size: number;
  file_type: string;
  extracted_content: string;
}

export interface CloudFileRef {
  file_uuid: string;
  file_name: string;
}

/** Top-level of users.json — single-element array. */
export interface CloudUser {
  uuid: string;
  full_name: string;
  email_address: string;
  verified_phone_number: string | null;
}

/** Top-level of projects.json. */
export interface CloudProject {
  uuid: string;
  name: string;
  description: string;
  is_private: boolean;
  is_starter_project: boolean;
  prompt_template: string;
  created_at: string;
  updated_at: string;
  creator: { uuid: string; full_name: string };
  docs: readonly CloudProjectDoc[];
}

export interface CloudProjectDoc {
  uuid: string;
  filename: string;
  content: string;
  created_at: string;
}

/** Top-level of memories.json — single-element array. */
export interface CloudMemories {
  account_uuid: string;
  conversations_memory: string;
  project_memories: Readonly<Record<string, string>>;
}
