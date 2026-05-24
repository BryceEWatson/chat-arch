// `narrative_evidence` child-table SDK. Owns the per-Narrative
// `evidence[]` array; rows are inserted in `evidence_index` order and
// returned that way on read. Replace-pattern mirrors
// `replaceSessionMessages`.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import type { NarrativeEvidenceRow, SessionKey } from './types.js';

interface RawNarrativeEvidenceRow {
  readonly narrative_id: string;
  readonly evidence_index: number;
  readonly session_source: string;
  readonly session_id: string;
  readonly anchor: string | null;
  readonly excerpt: string | null;
}

function rowFromRaw(raw: RawNarrativeEvidenceRow): NarrativeEvidenceRow {
  return {
    narrativeId: raw.narrative_id,
    evidenceIndex: raw.evidence_index,
    sessionSource: raw.session_source,
    sessionId: raw.session_id,
    anchor: raw.anchor,
    excerpt: raw.excerpt,
  };
}

const SELECT_COLUMNS =
  'narrative_id, evidence_index, session_source, session_id, anchor, excerpt';

export function listNarrativeEvidence(
  db: Database,
  narrativeId: string,
): readonly NarrativeEvidenceRow[] {
  return db
    .prepare<[string], RawNarrativeEvidenceRow>(
      `SELECT ${SELECT_COLUMNS} FROM narrative_evidence WHERE narrative_id = ? ORDER BY evidence_index`,
    )
    .all(narrativeId)
    .map(rowFromRaw);
}

export interface InsertNarrativeEvidenceInput {
  readonly evidenceIndex: number;
  readonly session: SessionKey;
  readonly anchor?: string | null;
  readonly excerpt?: string | null;
}

export async function replaceNarrativeEvidence(
  db: Database,
  narrativeId: string,
  inputs: readonly InsertNarrativeEvidenceInput[],
): Promise<readonly NarrativeEvidenceRow[]> {
  return withWriteTransaction(db, (tx) => {
    tx.prepare('DELETE FROM narrative_evidence WHERE narrative_id = ?').run(narrativeId);
    const insert = tx.prepare(
      `INSERT INTO narrative_evidence (narrative_id, evidence_index, session_source, session_id, anchor, excerpt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const input of inputs) {
      insert.run(
        narrativeId,
        input.evidenceIndex,
        input.session.source,
        input.session.id,
        input.anchor ?? null,
        input.excerpt ?? null,
      );
    }
    return listNarrativeEvidence(tx, narrativeId);
  });
}
