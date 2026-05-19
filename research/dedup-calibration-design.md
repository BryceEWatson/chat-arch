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
