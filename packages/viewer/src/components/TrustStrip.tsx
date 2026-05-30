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
    // Footer variant's body truncates with ellipsis at narrow desktop
    // widths (CSS: `white-space: nowrap; text-overflow: ellipsis`). Add
    // an explicit title= so the full pledge stays mouse-discoverable
    // when truncated; SR users get the full text from the visible span
    // textContent regardless of CSS truncation. Without title= the
    // truncated escape route was missing entirely.
    const footerBody = 'Parsed in your browser. No telemetry, no analytics.';
    return (
      <aside className={className} aria-label="local-first data handling">
        <div className="lcars-trust-strip__row">
          <span className="lcars-trust-strip__pledge">LOCAL-FIRST</span>
          <span className="lcars-trust-strip__body" title={footerBody}>
            {footerBody}
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
        Two caveats: (1) the optional <em>Analyze Topics</em> step downloads a
        36 MB embedding model from <code>huggingface.co</code> on first use
        (cached after) — no transcript content is uploaded. (2) The optional{' '}
        <em>Chat</em> page invokes your local Claude Code CLI, which forwards
        your question and the corpus excerpts the agent reads to Anthropic&apos;s
        API under your existing account (you&apos;ll see a disclosure on first
        send). Parsing, mining, audit, and analysis stay local.
      </div>
    </aside>
  );
}
