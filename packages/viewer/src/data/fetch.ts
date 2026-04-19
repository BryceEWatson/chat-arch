import type { SessionManifest, CloudConversation } from '@chat-arch/schema';
import { parseTranscript } from './transcriptParse.js';
import type { LocalTranscriptEntry } from '../types.js';

/**
 * The single network seam for the viewer. Components never call `fetch()`
 * directly (plan decision 18).
 *
 * Every function throws `Error` with a human-readable message on failure.
 * Callers translate that into `{ status: 'error', message }`.
 */

async function fetchJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Network error fetching ${url}: ${String(err)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(`Bad JSON from ${url}: ${String(err)}`);
  }
}

/**
 * Shape-validate a parsed manifest. Empty-but-valid (`sessions: []`) is NOT
 * an error — the empty state is rendered by the viewer downstream. This
 * catches the F12.1 trap where `manifest.json = "[]"` parses but lacks the
 * `sessions` array the rest of the viewer assumes.
 */
export function assertManifestShape(value: unknown): asserts value is SessionManifest {
  if (value === null || typeof value !== 'object') {
    throw new Error(
      'manifest.json is not a JSON object (expected { schemaVersion, sessions, … }).',
    );
  }
  const m = value as Record<string, unknown>;
  if (!Array.isArray(m['sessions'])) {
    throw new Error('manifest.json is missing the required `sessions` array.');
  }
  if (typeof m['counts'] !== 'object' || m['counts'] === null) {
    throw new Error('manifest.json is missing the required `counts` object.');
  }
  for (let i = 0; i < m['sessions'].length; i += 1) {
    const s = m['sessions'][i];
    if (s === null || typeof s !== 'object') {
      throw new Error(`manifest.sessions[${i}] is not an object.`);
    }
    const entry = s as Record<string, unknown>;
    if (typeof entry['id'] !== 'string' || typeof entry['source'] !== 'string') {
      throw new Error(`manifest.sessions[${i}] is missing required id/source fields.`);
    }
  }
}

export async function fetchManifest(url: string): Promise<SessionManifest> {
  const raw = await fetchJson<unknown>(url);
  assertManifestShape(raw);
  return raw;
}

export async function fetchConversation(url: string): Promise<CloudConversation> {
  return fetchJson<CloudConversation>(url);
}

/**
 * Fetch a local-transcript JSONL file and return the parsed entries.
 * Malformed lines are preserved as `_malformed` wrappers rather than thrown.
 */
export async function fetchTranscript(url: string): Promise<readonly LocalTranscriptEntry[]> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Network error fetching ${url}: ${String(err)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const text = await res.text();
  return parseTranscript(text);
}

/** Compose a data-root-relative URL for a transcriptPath entry. */
export function resolveDataUrl(dataRoot: string, relPath: string): string {
  const root = dataRoot.endsWith('/') ? dataRoot.slice(0, -1) : dataRoot;
  const path = relPath.startsWith('/') ? relPath.slice(1) : relPath;
  return `${root}/${path}`;
}
