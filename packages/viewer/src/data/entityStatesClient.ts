/**
 * Rev3-C C1+C2+C4 — client for the `/api/entity-states` endpoint.
 *
 * Generalizes the previous `knowledgeDebtStateClient`. Entries are
 * keyed by the composite `(entityKind, entityId)` — knowledge-debt
 * clusters AND narratives share one ledger.
 *
 * Read ladder (see `loadEntityStates` below for the implementation):
 * SQLite-backed `/api/entity-states` (top rung as of C4) → legacy v2
 * JSON sidecar (C1+C2) → legacy v1 sidecar (pre-C1). The JSON
 * sidecars are no longer written by the server — the SQLite table is
 * authoritative — but the static-fetch fallbacks remain so a user
 * who hasn't yet triggered a post-cutover write (and any static
 * deploy that lacks the API route) still sees their saved state.
 */

const ENTITY_STATES_PATH = '/api/entity-states';
const REQUIRED_HEADER_VALUE = 'chat-arch-entity-state';

export type EntityStateKind = 'knowledge-debt' | 'narrative';
export type EntityStateValue = 'PENDING' | 'INSTALLED' | 'DISMISSED';

export interface EntityStateEntry {
  entityKind: EntityStateKind;
  entityId: string;
  state: EntityStateValue;
  updatedAt: number;
  /**
   * Snapshot of the entity's "size" at the moment of state change.
   * For knowledge-debt clusters this is `sessionIds.length`; for
   * narratives this is `evidence.length`. Closure B's growth-multiplier
   * re-promotion rule compares the live size against this snapshot.
   */
  sizeAtState: number;
  /**
   * Phase Rev3-D Closure B counter — number of times this entry has
   * transitioned into `DISMISSED`. Read by the saturation rule
   * (`THRESHOLDS.narrativeRung.dismissDecay`, default ×2/×4/×8 cap
   * K=`narrativeRung.maxDismissals`) and by D2's per-Narrative
   * prior penalty. Optional for back-compat with legacy ledgers and
   * pre-counter v2 entries; readers default to 0 when absent.
   */
  dismissalCount?: number;
}

export interface EntityStatesFile {
  schemaVersion: 2;
  generatedAt: number;
  entries: readonly EntityStateEntry[];
}

export interface EntityStateResponse {
  ok: boolean;
  error?: string;
  entry?: EntityStateEntry;
}

function joinUrl(baseUrl: string, suffix: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const tail = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return `${root}/${tail}`;
}

interface LegacyEntry {
  clusterId?: unknown;
  state?: unknown;
  updatedAt?: unknown;
  sizeAtState?: unknown;
}

const KNOWN_STATES: ReadonlySet<EntityStateValue> = new Set([
  'PENDING',
  'INSTALLED',
  'DISMISSED',
]);

function migrateLegacyToV2(parsed: {
  generatedAt?: unknown;
  entries?: unknown;
}): EntityStatesFile | null {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    return null;
  }
  const entries: EntityStateEntry[] = [];
  for (const raw of parsed.entries as LegacyEntry[]) {
    if (typeof raw.clusterId !== 'string' || raw.clusterId.length === 0) continue;
    if (
      typeof raw.state !== 'string' ||
      !KNOWN_STATES.has(raw.state as EntityStateValue)
    ) {
      continue;
    }
    if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
      continue;
    }
    if (
      typeof raw.sizeAtState !== 'number' ||
      !Number.isFinite(raw.sizeAtState)
    ) {
      continue;
    }
    const state = raw.state as EntityStateValue;
    entries.push({
      entityKind: 'knowledge-debt',
      entityId: raw.clusterId,
      state,
      updatedAt: raw.updatedAt,
      sizeAtState: raw.sizeAtState,
      // Legacy ledger never tracked dismissal counts; seed at 1 for
      // already-DISMISSED entries so Closure B's saturation counter
      // starts from a defensible floor instead of 0.
      dismissalCount: state === 'DISMISSED' ? 1 : 0,
    });
  }
  return {
    schemaVersion: 2,
    generatedAt:
      typeof parsed.generatedAt === 'number' ? parsed.generatedAt : Date.now(),
    entries,
  };
}

async function fetchJsonOrNull(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Rev3-C C4 — entity-states are now served by the
 * `/api/entity-states` GET endpoint, backed by SQLite. The viewer
 * fetches the API in preference to any static JSON sidecar. If the
 * API isn't reachable (static deploy, no dev server) we fall back to
 * the legacy v2 JSON sidecar (from C1+C2) and then to the original
 * v1 sidecar — same back-compat ladder as PR #70, just with SQLite
 * as the new top rung.
 */
export async function loadEntityStates(
  baseUrl: string,
): Promise<EntityStatesFile | null> {
  // Top rung: the SDK-backed API. Returns `{ ok, available, entries }`
  // on success. The route is dev-server-only — on a static deploy it
  // 404s and we fall through to the JSON sidecar fallback.
  const apiResp = (await fetchJsonOrNull('/api/entity-states')) as
    | { ok?: unknown; entries?: unknown }
    | null;
  if (
    apiResp !== null &&
    typeof apiResp === 'object' &&
    apiResp.ok === true &&
    Array.isArray(apiResp.entries)
  ) {
    return {
      schemaVersion: 2,
      generatedAt: Date.now(),
      entries: apiResp.entries as EntityStateEntry[],
    };
  }

  // Legacy fallback 1 — v2 JSON sidecar written by C1+C2.
  const v2 = (await fetchJsonOrNull(
    joinUrl(baseUrl, 'analysis/entity-states.json'),
  )) as (EntityStatesFile & { schemaVersion?: number }) | null;
  if (v2 !== null && Array.isArray(v2.entries)) {
    if (v2.schemaVersion !== undefined && v2.schemaVersion !== 2) {
      return null;
    }
    return v2;
  }
  // Legacy fallback 2 — v1 JSON sidecar written pre-C1+C2.
  const v1 = (await fetchJsonOrNull(
    joinUrl(baseUrl, 'analysis/knowledge-debt-states.json'),
  )) as { generatedAt?: unknown; entries?: unknown } | null;
  if (v1 === null) return null;
  return migrateLegacyToV2(v1);
}

export async function setEntityState(
  entityKind: EntityStateKind,
  entityId: string,
  state: EntityStateValue,
  sizeAtState: number,
): Promise<EntityStateResponse> {
  try {
    const res = await fetch(ENTITY_STATES_PATH, {
      method: 'POST',
      headers: {
        'X-Requested-With': REQUIRED_HEADER_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ entityKind, entityId, state, sizeAtState }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: `entity-states failed (${res.status}): ${text}`,
      };
    }
    const body = (await res.json()) as EntityStateResponse;
    return body;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
