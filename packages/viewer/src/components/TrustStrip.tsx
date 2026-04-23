import { RepoLink } from './RepoLink.js';

/**
 * Landing trust strip. Renders directly under the TopBar on the empty
 * state so a first-time visitor sees the local-first pledge *before*
 * they decide whether to click SCAN LOCAL or UPLOAD CLOUD. Three
 * things get communicated:
 *
 *   1. "Local-first" — the top-line promise.
 *   2. The proof — browser-only parsing, no telemetry, transcripts
 *      never leave the machine.
 *   3. A SOURCE ↗ link to the open-source repo so the claim is
 *      verifiable, not just asserted.
 *
 * A footnote discloses the one exception we *do* make a cross-origin
 * fetch for: the first Analyze Topics run downloads the BGE-small
 * embedding model from huggingface.co (cached after). This sends only
 * the model-file request — no transcript content is ever uploaded.
 * The disclosure lives here (and not only in the AnalysisLauncher
 * where the fetch actually triggers) so the "no servers" read of the
 * body copy can't be technically-true-but-misleading for a user who
 * hasn't clicked anything yet.
 *
 * Kept intentionally lean (no icons, no graphics) so it reads as a
 * status-bar reassurance rather than an upsell banner. The strip
 * disappears once data is loaded — returning users don't need the
 * re-pitch every session.
 */
export function TrustStrip() {
  return (
    <aside
      className="lcars-trust-strip"
      aria-label="local-first data handling"
    >
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
