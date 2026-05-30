/**
 * ACTION-ITEMS selector — the Top-K representative ranking behind the
 * post-scan ActionItemsBanner, extracted VERBATIM from
 * `ChatArchViewer.tsx` (Phase 1 of the "Centralize data processing"
 * refactor).
 *
 * Two rankings, each contributing at most one row:
 *   - the highest-confidence / largest knowledge-debt cluster, and
 *   - the biggest |delta| disjoint-CI ITS contrast.
 *
 * Inline-Wilson note: the sibling `trustMisCalibrationFired` derivation
 * in ChatArchViewer used to hand-roll a Wilson CI under a (false)
 * "we don't want to depend on the analysis package here" comment. That
 * is gone — the boolean now routes through `build2x2` + `isTrustMisCalibrated`
 * from `./trust.js`, which call the shared `wilsonCI`. See `rankTopActionItems`
 * here for the ranking half; the trust boolean lives with the trust selector.
 *
 * Pure / deterministic / React-free. `unwrapEnvelope` comes from analysis.
 */

import type { KnowledgeDebtCluster } from '../detectKnowledgeDebt.js';
import type { ItsResult } from '../itsAnalysis.js';
import { THRESHOLDS } from '../thresholds.js';
import { unwrapEnvelope } from '../unwrapEnvelope.js';

/**
 * One representative row for the banner. The selector only ever emits
 * `kind: 'knowledge-debt' | 'its'` with `mode: 'insights'`; the banner's
 * own `TopItem` is structurally identical with wider unions (the banner
 * also accepts decisions / trust kinds it builds elsewhere).
 */
export interface TopItem {
  kind: 'knowledge-debt' | 'its';
  /** Short readable headline rendered as the link text. */
  headline: string;
  /** Tooltip / sub-text. */
  detail?: string;
  /** Mode to navigate to on click. */
  mode: 'insights';
}

/** Minimal knowledge-debt slice the ranking reads. */
export interface ActionItemsKnowledgeDebt {
  clusters: readonly KnowledgeDebtCluster[];
}

/** Minimal ITS slice the ranking reads. */
export interface ActionItemsIts {
  results: readonly ItsResult[];
}

/**
 * Build the Top-K representatives (knowledge-debt headline + ITS contrast)
 * exactly as ChatArchViewer's `topActionItems` useMemo did.
 */
export function rankTopActionItems(input: {
  knowledgeDebt: ActionItemsKnowledgeDebt | null;
  its: ActionItemsIts | null;
}): TopItem[] {
  const out: TopItem[] = [];
  // Highest-confidence + largest knowledge-debt cluster.
  const debt = input.knowledgeDebt;
  if (debt !== null && debt.clusters.length > 0) {
    // Strip harness wrappers from the canonical question and skip
    // slash-command invocations (e.g. "/shopsmith-menu") — those are
    // commands, not natural-language questions worth turning into a
    // rule, and leaking the raw <command-message> envelope into the
    // headline is exactly the noise this strip is meant to avoid.
    const cleaned = [...debt.clusters]
      .map((c) => ({ cluster: c, question: unwrapEnvelope(c.canonicalQuestion) }))
      .filter(
        (x): x is { cluster: (typeof debt.clusters)[number]; question: string } =>
          x.question !== null && !x.question.trimStart().startsWith('/'),
      );
    const top = cleaned.sort((a, b) => {
      const ca = a.cluster.confidence === 'high' ? 1 : 0;
      const cb = b.cluster.confidence === 'high' ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return b.cluster.sessionIds.length - a.cluster.sessionIds.length;
    })[0];
    if (top !== undefined) {
      const q =
        top.question.length > 80 ? top.question.slice(0, 77) + '…' : top.question;
      out.push({
        kind: 'knowledge-debt',
        headline: `recurring question (${top.cluster.sessionIds.length} sessions) — ${q}`,
        detail: `confidence ${top.cluster.confidence}`,
        mode: 'insights',
      });
    }
  }
  // Biggest |delta| disjoint-CI ITS contrast.
  const its = input.its;
  if (its !== null) {
    const clear = its.results
      .filter(
        (r) =>
          r.pre.n >= THRESHOLDS.display.minNForRate &&
          r.post.n >= THRESHOLDS.display.minNForRate &&
          ((r.deltaCI.low > 0 && r.deltaCI.high > 0) ||
            (r.deltaCI.low < 0 && r.deltaCI.high < 0)),
      )
      .sort((a, b) => Math.abs(b.deltaGoodShare) - Math.abs(a.deltaGoodShare));
    const top = clear[0];
    if (top !== undefined) {
      const pp = Math.round(top.deltaGoodShare * 100);
      out.push({
        kind: 'its',
        headline: `${top.subject || top.path} shifted good-share ${pp >= 0 ? '+' : ''}${pp} pp`,
        detail: `commit ${top.sha.slice(0, 7)}`,
        mode: 'insights',
      });
    }
  }
  return out;
}
