/**
 * Wave 7 P2 #9 — client for the `/api/knowledge-debt-state` endpoint
 * and the on-disk `analysis/knowledge-debt-states.json` ledger.
 *
 * Mirrors `insightsAckClient.ts` in shape — same single-flight POST,
 * same atomic ledger write on the server side. Distinct file so the
 * three-state semantics (`PENDING | INSTALLED | DISMISSED`) and the
 * size-on-dismiss snapshot don't pollute the boolean-ack ledger.
 */

const KNOWLEDGE_DEBT_STATE_PATH = '/api/knowledge-debt-state';
const REQUIRED_HEADER_VALUE = 'chat-arch-knowledge-debt-state';

export type KnowledgeDebtStateValue = 'PENDING' | 'INSTALLED' | 'DISMISSED';

export interface KnowledgeDebtStateEntry {
  clusterId: string;
  state: KnowledgeDebtStateValue;
  updatedAt: number;
  /**
   * Cluster size at the moment of state change. Used by the viewer to
   * decide whether a DISMISSED cluster should re-promote: when the
   * live cluster's size has grown by
   * `THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier`
   * from this snapshot, the dismissal is treated as stale.
   */
  sizeAtState: number;
}

export interface KnowledgeDebtStatesFile {
  schemaVersion: 1;
  generatedAt: number;
  entries: readonly KnowledgeDebtStateEntry[];
}

export interface KnowledgeDebtStateResponse {
  ok: boolean;
  error?: string;
  entry?: KnowledgeDebtStateEntry;
}

function joinUrl(baseUrl: string, suffix: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const tail = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return `${root}/${tail}`;
}

export async function loadKnowledgeDebtStates(
  baseUrl: string,
): Promise<KnowledgeDebtStatesFile | null> {
  const url = joinUrl(baseUrl, 'analysis/knowledge-debt-states.json');
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as KnowledgeDebtStatesFile;
    if (!body || !Array.isArray(body.entries)) return null;
    return body;
  } catch {
    return null;
  }
}

export async function setKnowledgeDebtState(
  clusterId: string,
  state: KnowledgeDebtStateValue,
  sizeAtState: number,
): Promise<KnowledgeDebtStateResponse> {
  try {
    const res = await fetch(KNOWLEDGE_DEBT_STATE_PATH, {
      method: 'POST',
      headers: {
        'X-Requested-With': REQUIRED_HEADER_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ clusterId, state, sizeAtState }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: `knowledge-debt-state failed (${res.status}): ${text}`,
      };
    }
    const body = (await res.json()) as KnowledgeDebtStateResponse;
    return body;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
