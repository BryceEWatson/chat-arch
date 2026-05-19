# Probability calibration for semantic dedup (design)

> Audit note (2026-05-19): an earlier draft of this doc cited
> "Park et al. 2026" and described mxbai-embed-large's cosine as BERT-
> style narrowly compressed. Both framings are wrong:
> - The real paper is Tacheny 2026 (arXiv:2601.16907), not Park.
> - mxbai is contrastively trained (InfoNCE on ~700M pairs + AnglE
>   loss on hard negatives + Matryoshka) — exactly the SimCSE/AnglE-
>   era fixes for narrow-cone anisotropy. Residual miscalibration
>   exists but isn't severe.
>
> Calibration on labeled pairs is still justified — Tacheny 2026
> formalises that *absolute* cosine is miscalibrated even when *rank*
> is preserved — but the framing is "tightening absolute-value
> interpretability on an already-contrastive model," not "fixing
> severe anisotropy." See research/calibration-audit-2026-05-19.md.

The labeling sweep on our corpus plateaus inside the high-cosine band:
no single cosine threshold gives reliable precision. The remedy is to
map cosine → P(near-dup) via a calibration curve and threshold on
probability instead of raw cosine. At our current label count (~70)
**Platt scaling** is the right fit method (Niculescu-Mizil & Caruana
2005 — sigmoid wins below ~200 samples, isotonic above ~1000); the
implementation auto-selects.

## On-disk location

`apps/standalone/public/chat-arch-data/calibration.json`. Sibling of
`manifest.json`, gitignored alongside the other populated artifacts.
Per-install, never checked in.

```jsonc
{
  "schemaVersion": 1,
  // "platt" below ~500 labels, "isotonic" above — auto-selected.
  "method": "platt",
  "calibratedAt": 1747606800000,
  "labelCount": 92,
  "band": [0.85, 1.0],
  // Same shape for both methods — a sorted (cos, p) sequence. For
  // isotonic these are the PAV step boundaries; for Platt they're
  // sampled from the fitted sigmoid at a fixed grid so the consumer
  // doesn't have to know the underlying form. evaluateCalibration
  // uses the knots either way; flat extrapolation outside the range.
  "knots": [
    { "cos": 0.85, "p": 0.05 },
    { "cos": 0.91, "p": 0.45 },
    { "cos": 0.94, "p": 0.85 },
    { "cos": 0.98, "p": 0.98 }
  ]
}
```

## `semanticAnalysis.ts` consumption

`duplicatesSemantic.ts` already accepts `options.threshold`. Add
`options.calibration?: CalibrationCurve`; when present, compare
`lookup(cos) >= P_NEAR_DUP_TARGET` instead of `cos >= threshold`. The
exporter's I/O shell reads `calibration.json` and passes the curve
through; absent file → undefined → existing literature-constant
threshold. No call-site changes outside the exporter.

## Cold start (no labels yet)

Absent `calibration.json` → undefined curve → fallback to
`DEFAULT_SEMANTIC_DUP_THRESHOLD`. First-time users get today's behavior;
the file appears only after the user opts in via `/calibrate`. Gate
fitting on ≥40 labels with at least one positive — below that PAV is
degenerate.

## Bounding below/above the labeled range

Recommend **flat extrapolation from the nearest endpoint**:
`p(cos < knots[0].cos) = knots[0].p`,
`p(cos > knots[N-1].cos) = knots[N-1].p`.

Two alternatives, both rejected:
- Linear extrapolation past the endpoints can produce `p > 1` or `p < 0`
  with sparse tail labels — a known PAV failure mode.
- Identity fallback outside the band silently re-introduces the
  anisotropy problem the calibration exists to fix.

Flat extrapolation degrades gracefully: out-of-band predictions are
constant rather than wrong.

## Schema version bump? Sidecar cache invalidation?

**Pro version bump**: calibration changes the *meaning* of dedup
output. A cluster at calibrated `p ≥ 0.95` is not interchangeable with
one at literature-constant cos 0.94. Bumping `EXPORTER_VERSION`
invalidates downstream caches and makes the lineage auditable.

**Con**: `calibration.json` is per-install and changes whenever the
user re-labels. A version bump every labeling pass churns the cache for
no code-level change. Calibration is data-derived; version is the wrong
granularity.

**Resolution**: don't bump `EXPORTER_VERSION`. Write a
`calibrationFingerprint` field into `analysis/meta.json` (sha256 of the
knots, or `"none"`). The incremental-rescan cache key includes this
fingerprint, so toggling calibration or re-fitting invalidates exactly
the dedup output without churning the rest of the pipeline. Same scoped
pattern as `HEURISTIC_RECALL_VERSION` in
`detectCorrectionCandidates.ts`.

---

## Learnings from the first two labeling passes (2026-05-19)

The calibration pipeline shipped end-to-end and was exercised across
two labeling passes (stratified 99-pair pass + active 80-pair pass)
on the user's ~500-session corpus, mxbai-embed-large embedder, dual
Claude-judge (Haiku 4.5 + Sonnet 4.6). Concrete findings worth
recording for the next investigator:

1. **Disagreement rate is high and stable**. Stratified 30/99 (30%),
   active 22/80 (28%). The audit predicted Tier 2b prompt-bias fixes
   (drop cosine anchor, A/B randomize, CoT-first schema) would drop
   disagreement 5-10 pp — empirically the shift was within Wilson
   noise. Best interpretation: the prior 30% was an *under-estimate*
   inflated by shared judge biases; the bias fixes exposed the true
   inter-judge floor, which is close to PARAPHRASUS-2024's reported
   20-35% on hardest-decile paraphrase pairs. The fixes were still
   the right call structurally; they just don't move the
   dual-judge-agreement number on a corpus this small.

2. **PAV at n=70 overfit visibly**. The first isotonic fit produced
   6 knots with a huge plateau (P=0.175 across [0.85, 0.994]) and a
   single jump to P=1.0 at cos≥0.994, dominated by 4-6 lone positives
   at the high-cos end. Switching to Platt at n<500 (per
   Niculescu-Mizil & Caruana 2005) produced a smooth, well-behaved
   sigmoid that didn't overconfidently extrapolate from sparse high-
   cos labels.

3. **Active sampling paid off**. After 99 stratified labels, max P
   at cos=1.0 was 0.42. After 80 active samples (concentrated in
   [0.96, 1.0] where the curve passes through P≈0.5), max P jumped
   to 0.74. That's a ~32-pp gain from a single 80-label pass; a
   second stratified pass of comparable size would not have done
   that.

4. **pTarget=0.9 was empirically unreachable**. Production-dedup
   precision targets of 0.95+ (Christen 2012; NeMo Curator) don't
   survive contact with this corpus and judge setup. The fitted
   curve max P plateaued at 0.74 — additional labels would push it
   higher but with diminishing returns. We landed at **pTarget=0.7**
   as the empirical ceiling, flagging ~7-10 cos≥0.99 pairs.

5. **Active samples are not representative**. The active pass's
   sample distribution was 100% in [0.96, 1.0] (all uncertainty
   was at the top of the curve). Precision-sweeps over actively-
   sampled labels are biased toward whatever band the curve happens
   to be uncertain about. The audit doc §1 flagged this; we
   accepted the bias for fit-quality gains and noted it inline. A
   future PR could maintain two label sets (stratified for sweep
   reporting, active for fitting).

6. **Plan-usage cost was small**. The whole investigation —
   stratified pass + active pass + multiple smoke tests — cost
   roughly $10 plan-equivalent (Claude Code subscription, not out-
   of-pocket). The cost ceiling for "label until pTarget=0.9 is
   reachable" is probably 5-10× that. Whether it's worth spending
   depends on whether someone uses the semantic-dedup view enough
   to justify; current evidence suggests not.

**Re-evaluate calibration when:**
- Label count crosses ~500 (transitions Platt → isotonic regime).
- A cross-family judge gets wired up (Tier 3 §3 — would shrink the
  shared-bias floor and could pull dual-judge agreement up).
- The corpus grows substantially or the embedding model is swapped.
