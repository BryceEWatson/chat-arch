import type {
  AppliedImprovement,
  AppliedImprovementsFile,
  CorrectionPattern,
  CorrectionsFile,
  ProposedUpgrade,
} from '@chat-arch/schema';

/**
 * Load a JSON sidecar from the analysis/ directory. Returns `null` for
 * 404 / network failure / parse failure — the panel treats absent files
 * the same as "pipeline hasn't run yet", which is the safe default.
 *
 * Sibling of `analysisFetch.ts` but typed against the corrections shape
 * because the panel cares about more than `generatedAt`.
 */
async function fetchCorrectionsJson(url: string): Promise<CorrectionsFile | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as CorrectionsFile;
    return body;
  } catch {
    return null;
  }
}

function joinAnalysisUrl(baseUrl: string, filename: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}/analysis/${filename}`;
}

/** Fetch `analysis/corrections.json`. */
export async function loadCorrectionsFile(baseUrl: string): Promise<CorrectionsFile | null> {
  return fetchCorrectionsJson(joinAnalysisUrl(baseUrl, 'corrections.json'));
}

/**
 * Fetch `analysis/correction-candidates.json`. Same shape as `corrections.json`
 * but contains pre-classification heuristic hits — used by the panel to
 * tell the user "N candidates ready, click MINE to classify them" before
 * the LLM pass has been run.
 */
export async function loadCorrectionCandidatesFile(
  baseUrl: string,
): Promise<CorrectionsFile | null> {
  return fetchCorrectionsJson(joinAnalysisUrl(baseUrl, 'correction-candidates.json'));
}

/**
 * Fetch `analysis/applied-improvements.json` — the user's APPLY-click
 * ledger. Returns null on 404 (file doesn't exist yet, common case
 * before the first apply) or any read failure; callers should treat
 * that the same as "no entries".
 */
export async function loadAppliedImprovementsFile(
  baseUrl: string,
): Promise<AppliedImprovementsFile | null> {
  const url = joinAnalysisUrl(baseUrl, 'applied-improvements.json');
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as AppliedImprovementsFile;
    if (!body || !Array.isArray(body.entries)) return null;
    // Reject unknown schema versions outright. A future writer may
    // bump the schema in a backwards-incompatible way (e.g. rename
    // `appliedAt` or change the proposedUpgrade shape); silently
    // accepting it would let the merge step downstream produce
    // misleading results. Treat unknown schema as "no ledger" — the
    // viewer behaves the same as a fresh install. Logged so a user
    // who notices their applies disappeared can find the cause.
    if (body.schemaVersion !== 1) {
      console.warn(
        `[correctionsLoader] applied-improvements.json schemaVersion=${
          (body as { schemaVersion?: unknown }).schemaVersion
        } is unsupported (expected 1). Ignoring file.`,
      );
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

/**
 * Idempotency key in the merge step: `(target, targetPath)` identifies
 * a `ProposedUpgrade` within a `CorrectionPattern`. Same triple
 * `(patternId, target, targetPath)` is the apply ledger's idempotency
 * key — kept consistent so an apply ↔ live-pattern roundtrip survives.
 */
function matchesUpgrade(u: ProposedUpgrade, applied: AppliedImprovement): boolean {
  return (
    u.target === applied.proposedUpgrade.target &&
    u.targetPath === applied.proposedUpgrade.targetPath
  );
}

/**
 * Merge the apply-ledger over a `CorrectionsFile` snapshot:
 *
 *   - For each `AppliedImprovement`, locate the matching pattern by
 *     `patternId` and the matching `ProposedUpgrade` by
 *     `(target, targetPath)`. Stamp `applied: true` and the ledger's
 *     `appliedAt` onto a fresh copy.
 *   - Recompute `recurringPostApplication` per pattern: if the
 *     pattern's `lastSeen` is greater than the max `appliedAt` across
 *     all applied upgrades, the rule is failing in practice and the
 *     viewer surfaces it in the RECURRING bucket.
 *
 * Pure / non-mutating — returns a new `CorrectionsFile`. The input is
 * not modified, so the caller can keep the raw `corrections.json`
 * around for diff / debugging.
 *
 * KNOWN FRAGILITY (`pattern.lastSeen > maxAppliedAt`):
 *   This compares the pattern's last-seen timestamp (an attribute of
 *   the underlying corpus, set during the most recent mining pass)
 *   against the max APPLY timestamp. If the user APPLYs and then
 *   immediately re-mines on a STALE window — i.e. a window that still
 *   ends in correction instances older than the apply but newer than
 *   the previous pattern.lastSeen — the pattern can flip to RECURRING
 *   even though the user hasn't pushed back since the apply. The
 *   long-term fix is to carry per-correction `detectedAtMs` and
 *   compare apply vs the latest *correction-instance* time, not
 *   pattern.lastSeen. Short-term this is acceptable because re-mines
 *   are infrequent and the false-positive direction (a "still
 *   recurring" badge that disappears on the next clean mine) is the
 *   safer side of the error budget — it asks the user to look again,
 *   it doesn't hide a regression.
 */
export function mergeAppliedImprovements(
  corrections: CorrectionsFile,
  applied: AppliedImprovementsFile | null,
): CorrectionsFile {
  if (!applied || applied.entries.length === 0) return corrections;

  // Bucket entries by patternId so each pattern is visited once.
  const byPattern = new Map<string, AppliedImprovement[]>();
  for (const entry of applied.entries) {
    const arr = byPattern.get(entry.patternId);
    if (arr) arr.push(entry);
    else byPattern.set(entry.patternId, [entry]);
  }

  const nextPatterns: CorrectionPattern[] = corrections.patterns.map((p) => {
    const ledgerForPattern = byPattern.get(p.id);
    if (!ledgerForPattern || ledgerForPattern.length === 0) return p;

    let maxAppliedAt = 0;
    const nextUpgrades: ProposedUpgrade[] = p.proposedUpgrades.map((u) => {
      const match = ledgerForPattern.find((entry) => matchesUpgrade(u, entry));
      if (!match) return u;
      if (match.appliedAt > maxAppliedAt) maxAppliedAt = match.appliedAt;
      return { ...u, applied: true, appliedAt: match.appliedAt };
    });

    // Even when no live ProposedUpgrade matched (the upgrades list
    // shifted between mining passes) the ledger still pins `applied`
    // semantics for the pattern — fall back to the max ledger entry.
    if (maxAppliedAt === 0) {
      for (const entry of ledgerForPattern) {
        if (entry.appliedAt > maxAppliedAt) maxAppliedAt = entry.appliedAt;
      }
    }

    const recurringPostApplication =
      maxAppliedAt > 0 && p.lastSeen > maxAppliedAt
        ? true
        : p.recurringPostApplication;

    return {
      ...p,
      proposedUpgrades: nextUpgrades,
      recurringPostApplication,
    };
  });

  return { ...corrections, patterns: nextPatterns };
}
