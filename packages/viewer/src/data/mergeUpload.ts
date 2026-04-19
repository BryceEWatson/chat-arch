import type {
  CloudConversation,
  SessionManifest,
  SessionSource,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import type { UploadedCloudData } from '../types.js';

/**
 * Merge-upload semantics for browser-tier cloud data.
 *
 * Cloud-export ZIPs from Settings → Privacy are cumulative snapshots: each new
 * export contains the full conversation history up to the export moment, so
 * a later ZIP is a superset in happy-path cases. The original upload flow
 * replaced state wholesale, which meant:
 *
 *   1. Uploading a newer ZIP lost any conversations only in the older ZIP
 *      (shouldn't happen in practice, but not defensively guarded).
 *   2. It clobbered the *fetched* manifest's cli/cowork/cli-desktop entries —
 *      the user's entire local history disappeared from the viewer until the
 *      ZIP was unloaded.
 *
 * This module gives the viewer two composable merges:
 *
 *   - {@link mergeUploads}: combine an existing in-memory uploaded dataset
 *     with a freshly-parsed ZIP. Deduplicates conversations by `id` (which
 *     is the stable `conversation.uuid` for cloud), preferring whichever
 *     copy has the greater `updatedAt`. Works for the "user uploaded a
 *     second ZIP" case and for "user uploaded the same ZIP twice" (idempotent).
 *
 *   - {@link effectiveManifest}: produce the manifest the viewer should
 *     render, given an optional fetched manifest and an optional uploaded
 *     dataset. Uploaded cloud entries take precedence over fetched cloud
 *     entries with the same id, and all non-cloud fetched entries pass
 *     through untouched so the user never loses their local history.
 */

/** `conversation.updatedAt` (ms-epoch) is the tiebreak for duplicate ids. */
function pickNewer(a: UnifiedSessionEntry, b: UnifiedSessionEntry): UnifiedSessionEntry {
  return (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a;
}

/**
 * Combine an existing uploaded dataset with freshly-parsed ZIP output.
 *
 * - `existing === null` → returns `incoming` unchanged (first upload).
 * - For overlapping conversation ids, the newer `updatedAt` wins in both
 *   the entries list and the `conversationsById` map.
 * - `sourceLabel` becomes a concatenation so the UNLOAD chip can show
 *   which ZIPs are active, separated by ` + `. Duplicates are de-duped.
 */
export function mergeUploads(
  existing: UploadedCloudData | null,
  incoming: UploadedCloudData,
): UploadedCloudData {
  if (!existing) return incoming;

  // Merge entries by id (== conversation.uuid for cloud sources).
  const byId = new Map<string, UnifiedSessionEntry>();
  for (const e of existing.manifest.sessions) byId.set(e.id, e);
  for (const e of incoming.manifest.sessions) {
    const prev = byId.get(e.id);
    byId.set(e.id, prev ? pickNewer(prev, e) : e);
  }
  const sessions = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  // Merge conversation bodies — same key, newer entry's body wins (by
  // tiebreak on updatedAt).
  const conversationsById = new Map<string, CloudConversation>(existing.conversationsById);
  for (const [id, conv] of incoming.conversationsById) {
    const prior = conversationsById.get(id);
    if (!prior) {
      conversationsById.set(id, conv);
      continue;
    }
    // Prefer whichever conversation corresponds to the newer entry we
    // kept above. Fall back to the incoming copy if neither side has a
    // usable `updated_at`.
    const priorTs = Date.parse(prior.updated_at ?? '');
    const nextTs = Date.parse(conv.updated_at ?? '');
    conversationsById.set(id, nextTs >= priorTs ? conv : prior);
  }

  // Recompute counts from the merged session list so the stats card
  // (VISIBLE N / N) reflects the merged view.
  const counts: Record<SessionSource, number> = {
    cloud: 0,
    cowork: 0,
    'cli-direct': 0,
    'cli-desktop': 0,
  };
  for (const e of sessions) counts[e.source] += 1;

  const existingLabels = existing.sourceLabel.split(' + ').filter(Boolean);
  const labelSet = new Set(existingLabels);
  labelSet.add(incoming.sourceLabel);
  const sourceLabel = [...labelSet].join(' + ');

  return {
    manifest: {
      schemaVersion: Math.max(existing.manifest.schemaVersion, incoming.manifest.schemaVersion) as
        | 1
        | 2,
      generatedAt: Date.now(),
      counts,
      sessions,
    },
    conversationsById,
    sourceLabel,
  };
}

/**
 * Produce the manifest the viewer should render.
 *
 * - No uploaded data → return the fetched manifest verbatim (or null).
 * - Uploaded data only → return its manifest.
 * - Both present → replace the fetched manifest's cloud entries with the
 *   uploaded ones (uploaded cloud is authoritative; it's newer user data
 *   from a fresh export), and keep every non-cloud fetched entry intact
 *   so the user's local cli / cowork / cli-desktop history continues to
 *   show up. Merged counts are recomputed.
 *
 * This is a pure function of its inputs — the caller memoizes.
 */
export function effectiveManifest(
  fetched: SessionManifest | null,
  uploaded: UploadedCloudData | null,
): SessionManifest | null {
  if (!uploaded) return fetched;
  if (!fetched) return uploaded.manifest;

  // Keep non-cloud fetched entries + overlay uploaded cloud entries.
  const nonCloudFetched = fetched.sessions.filter((s) => s.source !== 'cloud');
  const merged = [...nonCloudFetched, ...uploaded.manifest.sessions].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  const counts: Record<SessionSource, number> = {
    cloud: 0,
    cowork: 0,
    'cli-direct': 0,
    'cli-desktop': 0,
  };
  for (const e of merged) counts[e.source] += 1;

  return {
    schemaVersion: Math.max(fetched.schemaVersion, uploaded.manifest.schemaVersion) as 1 | 2,
    generatedAt: Date.now(),
    counts,
    sessions: merged,
  };
}
