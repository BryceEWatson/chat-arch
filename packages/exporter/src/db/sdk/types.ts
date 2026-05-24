// Row types for the chat-arch SQLite SDK (Phase Rev3-A.A8).
//
// One Row interface per table in `001-initial-schema.ts`, exposed in
// camelCase. The SDK maps to/from the snake_case DDL columns at the
// boundary so callers don't have to know about the SQL shape.
//
// Provenance fields land in Rev3-B (schema_version bump on narratives);
// this file matches schema_version=1 throughout.

export type Sentiment = 'positive' | 'negative' | 'mixed';
export type TranscriptStatus = 'present' | 'pruned' | 'missing';
export type SessionMessageRole = 'user' | 'assistant' | 'tool' | 'system';

/** Composite key for a session — `(source, id)` matches the schema PK. */
export interface SessionKey {
  readonly source: string;
  readonly id: string;
}

export interface AnalyzerRow {
  readonly name: string;
  readonly version: string;
  /** ms since epoch; null until first run. */
  readonly lastRunAt: number | null;
  /** ms since epoch; null until per-kernel calibration completes. */
  readonly calibrationCompletedAt: number | null;
  readonly prior: number;
}

export interface ProjectRow {
  readonly id: string;
  readonly displayName: string;
  /** ISO-8601 string per existing schema convention. */
  readonly discoveredAt: string;
  readonly lastActivityAt: string;
  readonly sentiment: string;
  readonly source: string;
}

export interface TopicRow {
  readonly id: string;
  readonly displayName: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface SessionRow extends SessionKey {
  readonly rawSessionId: string;
  /** ms since epoch — UnifiedSessionEntry convention (numeric). */
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly durationMs: number;
  readonly title: string;
  readonly titleSource: string;
  readonly preview: string | null;
  readonly projectId: string | null;
  readonly messageCount: number;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly tokensCacheCreation: number;
  readonly tokensCacheRead: number;
}

export interface SessionMessageRow {
  readonly sessionSource: string;
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly role: string;
  readonly content: string | null;
  readonly timestamp: number | null;
}

export interface SessionRevisionRow {
  /** Autoincrement INTEGER PK. */
  readonly id: number;
  readonly sessionSource: string;
  readonly sessionId: string;
  readonly observedAt: number;
  readonly transcriptStatus: string;
}

export interface NarrativeRow {
  readonly id: string;
  readonly projectId: string;
  readonly sentiment: string;
  readonly title: string;
  readonly body: string;
  readonly generatedAt: string;
  readonly actionType: string;
  readonly schemaVersion: number;
}

export interface NarrativeEvidenceRow {
  readonly narrativeId: string;
  readonly evidenceIndex: number;
  readonly sessionSource: string;
  readonly sessionId: string;
  readonly anchor: string | null;
  readonly excerpt: string | null;
}

export interface PatternRow {
  readonly id: string;
  readonly sourceNarrativeId: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly encodedAt: string;
  /** SQLite stores 0/1; SDK exposes as boolean. */
  readonly appendedToClaudeMd: boolean;
}

export interface FindingRow {
  /** Autoincrement INTEGER PK. */
  readonly id: number;
  readonly kernel: string;
  /** Raw JSON string; callers parse to their own kernel-specific shape. */
  readonly payloadJson: string;
  readonly emittedAt: number;
  readonly projectId: string | null;
  readonly topicId: string | null;
  readonly sessionSource: string | null;
  readonly sessionId: string | null;
  readonly narrativeId: string | null;
  readonly patternId: string | null;
}

/** Junction-row shapes (all are simple two/three-column link tables). */
export interface ProjectSessionLink {
  readonly projectId: string;
  readonly sessionSource: string;
  readonly sessionId: string;
}

export interface ProjectTopicLink {
  readonly projectId: string;
  readonly topicId: string;
}

export interface TopicSessionLink {
  readonly topicId: string;
  readonly sessionSource: string;
  readonly sessionId: string;
}

export interface NarrativeSessionLink {
  readonly narrativeId: string;
  readonly sessionSource: string;
  readonly sessionId: string;
}

/**
 * Filter shape for `listFindings`. All fields are optional and combine
 * conjunctively. `null` filters match the actual SQL NULL value (so you
 * can find "unanchored findings" with `{projectId: null}`).
 */
export interface FindingsFilter {
  readonly kernel?: string;
  readonly projectId?: string | null;
  readonly topicId?: string | null;
  readonly narrativeId?: string | null;
  readonly patternId?: string | null;
}
