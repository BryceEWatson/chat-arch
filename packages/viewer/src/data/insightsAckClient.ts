/**
 * Wave 6 #3c — client for `POST /api/insights-ack` + loader for
 * `analysis/insights-acks.json`.
 *
 * The endpoint records an "I've reviewed this" mark on an
 * insights-mode item (currently ITS contrast rows); the sidecar drives
 * the post-scan banner so acknowledged items don't compete for
 * attention next session.
 */

const INSIGHTS_ACK_PATH = '/api/insights-ack';
const REQUIRED_HEADER_VALUE = 'chat-arch-insights-ack';

export type InsightsAckKind =
  | 'its-contrast'
  | 'knowledge-debt'
  | 'reflexive'
  | 'other';

export interface InsightsAckEntry {
  id: string;
  kind: InsightsAckKind;
  acknowledgedAt: number;
}

export interface InsightsAcksFile {
  schemaVersion: 1;
  generatedAt: number;
  entries: readonly InsightsAckEntry[];
}

export interface InsightsAckResponse {
  ok: boolean;
  error?: string;
  entry?: InsightsAckEntry;
  existed?: boolean;
}

function joinUrl(baseUrl: string, suffix: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const tail = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return `${root}/${tail}`;
}

export async function loadInsightsAcks(
  baseUrl: string,
): Promise<InsightsAcksFile | null> {
  const url = joinUrl(baseUrl, 'analysis/insights-acks.json');
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as InsightsAcksFile;
    if (!body || !Array.isArray(body.entries)) return null;
    return body;
  } catch {
    return null;
  }
}

export async function ackInsight(
  kind: InsightsAckKind,
  id: string,
): Promise<InsightsAckResponse> {
  try {
    const res = await fetch(INSIGHTS_ACK_PATH, {
      method: 'POST',
      headers: {
        'X-Requested-With': REQUIRED_HEADER_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id, kind }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `insights-ack failed (${res.status}): ${text}` };
    }
    const body = (await res.json()) as InsightsAckResponse;
    return body;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
