import { useState, type ReactNode } from 'react';

/**
 * Surface-visible methodology & limitations disclosure for the
 * outcome-substrate viewer modes (EffectivenessMode, InsightsMode).
 *
 * Plan §"Methodology disclosure surface" — every outcome-flavored
 * surface gets this link, expanded section enumerates the load-bearing
 * caveats: confounding by indication, self-selection, composite-weight
 * provenance, multiple-testing scope, autocorrelation, sample-size
 * guards, E-value caveats, no-causal-language lint.
 *
 * Surface-visible by default — the user should never have to leave the
 * mode to learn how to read the numbers. We render a link styled to
 * read as a chip; click expands into an inline `<details>`-style block
 * (without the native disclosure widget so the LCARS chrome lines up).
 */

const CAVEATS: ReadonlyArray<{ title: string; body: ReactNode }> = [
  {
    title: 'Confounding by indication',
    body: (
      <>
        Sessions where you reached for a specific tool, prompt, or skill
        are not a random draw — they reflect what the problem looked
        like in the moment. Any contrast between groups co-varies with
        problem difficulty, fatigue, time of day, and dozens of other
        factors we don&rsquo;t capture.
      </>
    ),
  },
  {
    title: 'Self-selection',
    body: (
      <>
        You decide which sessions to start and how long to keep going.
        Treated vs. control comparisons inherit that selection — the
        groups differ on whatever made you pick one path over the
        other.
      </>
    ),
  },
  {
    title: 'Composite-weight provenance',
    body: (
      <>
        The composite score is a weighted sum of objective signals (PR
        landings, test passes, build passes, rework, affirmation). The
        weights are the author&rsquo;s judgement, version-stamped and
        refittable. A different weighting may surface different
        trajectories. Surface drops the cached file and recomputes when
        the weights version bumps.
      </>
    ),
  },
  {
    title: 'Multiple-testing scope',
    body: (
      <>
        Every config-impact card is one statistical comparison. With
        many cards the chance of seeing a wide CI on at least one
        rises mechanically. Treat each CI as one piece of evidence,
        not a tested hypothesis.
      </>
    ),
  },
  {
    title: 'Autocorrelation',
    body: (
      <>
        Sessions cluster in time — a productive week is correlated
        across its own days. Weekly aggregates and EWMA smoothing
        mask some of this; CIs still treat weeks as independent and
        will under-cover when serial correlation is strong.
      </>
    ),
  },
  {
    title: 'Sample-size guards',
    body: (
      <>
        Surfaces hide rates when n &lt; THRESHOLDS.display.minNForRate (8)
        and clusters when size &lt; THRESHOLDS.clustering.minClusterSize.
        Empty states beat noisy small-sample readings.
      </>
    ),
  },
  {
    title: 'E-value caveats',
    body: (
      <>
        The reflexive E-value bounds how strong an unobserved confounder
        would have to be to fully explain the matched-pair contrast.
        It is computed on the CI bound nearest the null, not the point
        estimate. When the CI straddles null we surface
        &ldquo;N/A &mdash; contrast not distinguishable from null&rdquo;
        rather than a misleading number.
      </>
    ),
  },
  {
    title: 'No-causal-language lint',
    // allow-causal: this entry is the methodology disclosure that has to
    // NAME the forbidden tokens by reference to disavow them. Suppression
    // applies to the JSX body below.
    body: (
      <>
        Viewer copy across these surfaces is checked against a {/* allow-causal */}
        no-causal-language linter — words like &ldquo;because&rdquo;, {/* allow-causal */}
        &ldquo;caused by&rdquo;, &ldquo;due to&rdquo;, and {/* allow-causal */}
        &ldquo;effect of&rdquo; are forbidden. Reading the surface {/* allow-causal */}
        as a causal estimate is reading it wrong.
      </>
    ),
  },
];

export function MethodologyDisclosure() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="lcars-methodology" aria-label="methodology and limitations">
      <button
        type="button"
        className="lcars-methodology__toggle"
        aria-expanded={expanded}
        aria-controls="lcars-methodology-body"
        onClick={() => setExpanded((v) => !v)}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{' '}
        Methodology &amp; limitations
      </button>
      {expanded && (
        <div
          id="lcars-methodology-body"
          className="lcars-methodology__body"
          role="region"
          aria-label="methodology details"
        >
          <p className="lcars-methodology__lead">
            These surfaces show descriptive contrasts and trajectories
            over your own corpus. They are not causal estimates. Read
            each card alongside the caveats below.
          </p>
          <ul className="lcars-methodology__list">
            {CAVEATS.map((c) => (
              <li key={c.title} className="lcars-methodology__item">
                <strong className="lcars-methodology__item-title">
                  {c.title}
                </strong>
                <span className="lcars-methodology__item-body">{c.body}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
