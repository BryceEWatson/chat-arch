/**
 * Phase Rev3-F F9 — client for the curator feed sidecar.
 *
 * Reads `chat-arch-data/analysis/curator-feed.json` (produced by the
 * /curate skill — F1+F2 scaffolds; full pipeline lands when F3+F4
 * kernels + the skill orchestration ships). When the file is
 * absent, returns `null` so the PRACTICE surface renders an
 * "awaiting first curator run" empty state.
 *
 * The on-disk shape is pinned by `.claude/skills/curate/SKILL.md`
 * Stage 3 — keep this client's types in sync.
 */

export type CuratorItemKind = 'narrative' | 'knowledge-debt' | 'applied-pattern';

export type CuratorFalsifierStatus =
  | 'verified'
  | 'skipped-by-user'
  | 'unavailable';

export interface CuratorFeedItem {
  readonly kind: CuratorItemKind;
  readonly entityId: string;
  readonly title: string;
  readonly rank: number;
  readonly compositeScore: number;
  /**
   * Per the F3 ranker's iter-1 fix: true iff this item won its
   * rank by the within-tier correlation tie-breaker. Surfaced so
   * the UI can render "(tie-broken by correlation)" for debugging
   * and F8 precision@k attribution.
   */
  readonly tieBrokenByCorrelation?: boolean;
  readonly falsifierStatus?: CuratorFalsifierStatus;
  /** One-line rationale from the curator. Optional. */
  readonly reasoning?: string;
}

export interface CuratorFeedFile {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly ranAt: string;
  readonly items: readonly CuratorFeedItem[];
  /**
   * Optional drift banner state from F8's meta-validation kernel.
   * When `inDrift` is true, the PRACTICE feed renders a top-of-
   * section banner so the user knows the falsifier's accuracy is
   * outside the calibration floor.
   */
  readonly metaAccuracy?: {
    readonly inDrift: boolean;
    readonly n: number;
    readonly accuracy: number;
    readonly lowerBound: number;
    readonly floor: number;
  };
}

function joinUrl(baseUrl: string, suffix: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const tail = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return `${root}/${tail}`;
}

const KNOWN_KINDS: ReadonlySet<CuratorItemKind> = new Set([
  'narrative',
  'knowledge-debt',
  'applied-pattern',
]);

const KNOWN_FALSIFIER_STATUSES: ReadonlySet<CuratorFalsifierStatus> = new Set([
  'verified',
  'skipped-by-user',
  'unavailable',
]);

/**
 * Strict shape validator. The on-disk file is produced by the
 * /curate skill subprocess — defensive parsing prevents a corrupt
 * write from crashing the viewer (the PRACTICE surface should
 * gracefully degrade to "no curator items" rather than throw).
 */
function isValidItem(raw: unknown): raw is CuratorFeedItem {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !KNOWN_KINDS.has(o.kind as CuratorItemKind)) {
    return false;
  }
  if (typeof o.entityId !== 'string' || o.entityId.length === 0) return false;
  if (typeof o.title !== 'string') return false;
  if (typeof o.rank !== 'number' || !Number.isFinite(o.rank)) return false;
  if (typeof o.compositeScore !== 'number' || !Number.isFinite(o.compositeScore)) {
    return false;
  }
  if (
    o.falsifierStatus !== undefined &&
    (typeof o.falsifierStatus !== 'string' ||
      !KNOWN_FALSIFIER_STATUSES.has(o.falsifierStatus as CuratorFalsifierStatus))
  ) {
    return false;
  }
  return true;
}

export async function loadCuratorFeed(
  baseUrl: string,
): Promise<CuratorFeedFile | null> {
  let res: Response;
  try {
    res = await fetch(joinUrl(baseUrl, 'analysis/curator-feed.json'), {
      cache: 'no-store',
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.schemaVersion !== 1) return null;
  if (!Array.isArray(p.items)) return null;
  const items: CuratorFeedItem[] = [];
  for (const raw of p.items) {
    if (isValidItem(raw)) items.push(raw);
  }
  const base: CuratorFeedFile = {
    schemaVersion: 1,
    generatedAt: typeof p.generatedAt === 'number' ? p.generatedAt : Date.now(),
    ranAt: typeof p.ranAt === 'string' ? p.ranAt : new Date().toISOString(),
    items,
  };
  if (typeof p.metaAccuracy === 'object' && p.metaAccuracy !== null) {
    return {
      ...base,
      metaAccuracy: p.metaAccuracy as NonNullable<CuratorFeedFile['metaAccuracy']>,
    };
  }
  return base;
}
