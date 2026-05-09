import { RepoLink } from './RepoLink.js';

export type TrustStripVariant = 'landing' | 'footer';

export interface TrustStripProps {
  /**
   * `landing` (default) — full pre-load reassurance with the Hugging
   * Face footnote. `footer` — Phase 2a leaner one-line variant that
   * persists below the populated frame; drops the HF footnote because
   * by that point the user has either already triggered the embedding
   * download or never will.
   */
  variant?: TrustStripVariant;
}

/**
 * Trust strip. Two variants:
 *
 *   - `landing` (the original) renders directly under the TopBar on
 *     the empty state so a first-time visitor sees the local-first
 *     pledge *before* they decide whether to click SCAN LOCAL or
 *     UPLOAD CLOUD. Includes the HF model-download footnote so the
 *     "no servers" read can't be technically-true-but-misleading.
 *   - `footer` renders inside the populated frame so the pledge stays
 *     visible after the empty state is gone — Phase 2a's "trust as
 *     ambient chrome" cue. Single row, no footnote, mobile-hidden.
 *
 * Kept intentionally lean (no icons, no graphics) so it reads as a
 * status-bar reassurance rather than an upsell banner.
 */
export function TrustStrip({ variant = 'landing' }: TrustStripProps = {}) {
  const className =
    'lcars-trust-strip' + (variant === 'footer' ? ' lcars-trust-strip--footer' : '');
  if (variant === 'footer') {
    return (
      <aside className={className} aria-label="local-first data handling">
        <div className="lcars-trust-strip__row">
          <span className="lcars-trust-strip__pledge">LOCAL-FIRST</span>
          <span className="lcars-trust-strip__body">
            Parsed in your browser. No telemetry, no analytics.
          </span>
          <RepoLink variant="inline" label="VIEW SOURCE" />
        </div>
      </aside>
    );
  }
  return (
    <aside className={className} aria-label="local-first data handling">
      <div className="lcars-trust-strip__row">
        <span className="lcars-trust-strip__pledge">LOCAL-FIRST</span>
        <span className="lcars-trust-strip__body">
          Parsed in your browser. No telemetry, no analytics. Your transcripts
          never leave your machine.
        </span>
        <RepoLink variant="inline" label="VIEW SOURCE" />
      </div>
      <div className="lcars-trust-strip__footnote">
        One caveat: the optional <em>Analyze Topics</em> step downloads a 36 MB
        embedding model from <code>huggingface.co</code> on first use (cached
        after). No transcript content is ever uploaded.
      </div>
    </aside>
  );
}
