# Calibration pipeline audit — 2026-05-19

Five parallel research agents audited the assumptions and choices made
across the calibration work on PR #52 (commits 34826bd through
170d6fe). This document summarises findings, flags errors in committed
work, and proposes concrete follow-ups.

Verdict: the **shape** of the pipeline is defensible. Several
**citations** are wrong, two **methodology defaults** are wrong for our
sample size, and several **LLM-judge best practices** are missing.

---

## 1. Citations — three of four are wrong

| Claim in committed work | Status | Fix |
|---|---|---|
| Park et al. 2026, *"Calibrated Similarity for Reliable Geometric Analysis"* | **Misattributed.** A real paper with that exact title exists at [arXiv:2601.16907](https://arxiv.org/abs/2601.16907) (Jan 2026) — but the author is **Nicolas Tacheny (Univ. of Mons), not Park**. The paper doesn't mention mxbai-embed-large specifically. | Replace "Park et al. 2026" with Tacheny 2026 for the calibration-on-labels framing, and pair with **Ethayarajh 2019** ([ACL D19-1006](https://aclanthology.org/D19-1006/)) for the canonical "narrow cone" anisotropy citation. |
| Katariya 2016, stratified sampling ~65% variance reduction at equal labor | **Fabricated.** Real Sumeet Katariya 2016 is on ranking bandits (DCM Bandits, ICML 2016) — nothing to do with stratified sampling. The "65%" figure has no provenance. | Drop the citation. Replace with Cochran 1977 (*Sampling Techniques*, Ch. 5) and revise the variance-reduction claim to **"typically 20–40%"** unless we measure our own. |
| Abbas et al. 2023, *SemDeDup* — *"calibrates the full high range"* | **Real paper, mischaracterised.** Abbas 2023 ([arXiv:2303.09540](https://arxiv.org/abs/2303.09540)) is k-means clustering + within-cluster cosine-threshold pruning. It does not calibrate; it sweeps `ε ∈ [0.001, 0.03]` over thresholds. The "boilerplate > 0.97" framing is our own observation. | Cite SemDeDup for the dedup-via-cosine-threshold methodology. Strip the "calibrates full range" line from comments + the design doc. |
| Brown, Cai & DasGupta 2001, *Interval Estimation for a Binomial Proportion* | **Verified.** [DOI 10.1214/ss/1009213286](https://projecteuclid.org/journals/statistical-science/volume-16/issue-2/Interval-Estimation-for-a-Binomial-Proportion/10.1214/ss/1009213286.full). Wilson 95% CI for p̂=0.5, n=10 → [0.236593, 0.763407] — matches our unit-test values. | Keep. |

**Where these appear in committed code/docs:**

- [research/dedup-calibration-design.md](dedup-calibration-design.md) — Park 2026, SemDeDup mischar
- [packages/analysis/src/calibration.ts](../packages/analysis/src/calibration.ts) header — Park 2026
- [packages/analysis/src/duplicatesSemantic.ts](../packages/analysis/src/duplicatesSemantic.ts) `BuildSemanticDuplicatesOptions.calibration` comment — Park 2026
- [packages/exporter/src/analysis/semanticAnalysis.ts](../packages/exporter/src/analysis/semanticAnalysis.ts) `loadCalibration` comment — Park 2026
- Commit messages 09c5713 (Katariya 65%), 12ce2be (Park), 170d6fe (Park)

Commit messages can't be safely amended (already pushed); fix only the
in-repo references, and note in the audit commit that prior messages
were incorrect.

---

## 2. Anisotropy framing — overstated for mxbai

We described mxbai-embed-large as compressing absolute cosine into a
narrow cone, citing Park 2026. The actual story:

- mxbai is trained with **contrastive InfoNCE on ~700M pairs**
  ([Mixedbread blog](https://www.mixedbread.com/blog/mxbai-embed-large-v1))
  — the SimCSE-style fix for BERT-era anisotropy.
- It's then fine-tuned with **AnglE loss on 30M triplets with hard
  negatives** ([Li & Li 2023, arXiv:2309.12871](https://arxiv.org/abs/2309.12871)),
  which targets the gradient saturation near cos = ±1.
- Matryoshka representation learning is also applied.

So the "BERT narrow cone" framing (Ethayarajh 2019) is a **category
error** applied to mxbai. The residual miscalibration is real but
weaker than implied. The 70-label sweep on our corpus still shows the
plateau, so isotonic calibration is justified — just not for the
reason we stated.

Reframe: "*tightening absolute-value interpretability on an already-
contrastive model*", not "*fixing severe anisotropy*."

---

## 3. Statistical methodology — three suboptimal choices

| Choice | Verdict | Fix |
|---|---|---|
| Wilson 95% CI for n=12–70, p̂ ∈ [0.27, 0.86] | **Correct.** Brown/Cai/DasGupta 2001 explicitly recommend Wilson for this regime. | None. |
| **PAV at n=70** | **Suboptimal.** Niculescu-Mizil & Caruana 2005: isotonic dominates above ~1000 samples; Platt wins below ~200. PAV at n=70 overfits step functions to noise — which is exactly what our 6-knot output shows (huge P=0.175 plateau, then a single jump at 0.994). | At n < 500, use **Platt scaling (sigmoid fit)** or **beta calibration** (Kull et al. 2017). Revisit PAV when labels exceed ~500. Alternatively: bootstrap or 5-fold CV-PAV to reduce overfit. |
| Flat extrapolation outside labeled range | **Correct.** sklearn `IsotonicRegression(out_of_bounds='clip')` default. Linear extrapolation can yield p < 0 or p > 1. | None. |
| `MIN_LABELS_FOR_FIT = 40` with "≥1 of each class" | **Too permissive.** A single positive at the high-cosine end will dominate the fit. Niculescu-Mizil & Caruana note isotonic is unstable below ~50; modern calibration papers use ≥100. | Require **≥10 positives AND ≥10 negatives** in addition to n ≥ 50. Below that, fall back to literature threshold. |
| `DEFAULT_P_NEAR_DUP_TARGET = 0.5` | **Wrong default for dedup.** Production dedup pipelines target precision ≥ 0.95 (Broder 1997, Christen 2012, NeMo Curator). Our 0.94 cosine choice was already in this regime. 0.5 = "more likely than not" misleads users into thinking dedup is balanced-loss. | Default to **0.9** (or expose a precision target instead of a probability target). |
| Equal-width cosine buckets for stratification | **Correct.** For calibration the stratification variable (cosine) is the quantity of interest; equal-width gives coverage across the curve. Equal-frequency would starve the tails. | None. |
| "Stratified sampling cuts variance ~65%" | **Overstated.** Cochran 1977: 20–40% is typical for binary outcomes with bucket-defined strata; 65% requires near-perfect stratum separation. | Soften the claim to "typically 20–40%" or measure on our own buckets. |

---

## 4. Near-duplicate detection — shape is correct, scale is on the small end

Production pipelines (NeMo Curator, SemDeDup, RedPajama, BigCode, Dolma,
text-dedup) ship with these defaults:

| Pipeline | Algo | Threshold |
|---|---|---|
| SemDeDup (paper, Meta AI) | cosine | 1 − ε, ε ∈ [0.001, 0.03] |
| NeMo Curator semantic | cosine | 0.99 (ε=0.01) |
| BigCode / The Stack | MinHash Jaccard | 0.85 |
| RedPajama-v2 / SlimPajama | MinHash Jaccard | 0.80 |
| text-dedup | MinHash Jaccard | 0.70 |

**For our 1k–10k corpus, cosine + threshold + complete-linkage is the
right shape.** MinHash only wins at scale (>100k where O(N²) cosine
hurts). Layering exact → MinHash → semantic is standard at trillion-
token scale; for us, exact + cosine is enough.

**Calibration on labeled pairs is non-standard but defensible.**
Published pipelines pick thresholds by manual inspection of a few
hundred pairs (BigCode, RedPajama) — not by fitted curve. Tacheny 2026
endorses our approach academically; nobody ships it in production
dedup yet. We're slightly ahead of the SOTA on the calibration axis,
but at a label count (70) where Platt is the safer choice than
isotonic.

**Gaps worth closing later** (none blocking):

- **Per-workflow-tag thresholds** — our corpus has heterogeneous
  session types (code vs prose vs config-debug); a global threshold
  over-prunes prose and under-prunes code.
- **Active sampling to grow labels past 300** — sample the most
  uncertain pairs under the current curve. Closes the
  calibration-set-size gap fast.
- **Distill agreed labels into a small classifier** — Liu 2024
  (NLP+CSS) and AutoAnnotator 2025 show pseudo-labels + small
  fine-tune beats raw LLM judging at 1/10 the cost.

---

## 5. LLM-as-judge — four high-ROI fixes missing

The 30% dual-judge disagreement rate is roughly expected for the
adversarial [0.85, 1.0] band (PARAPHRASUS 2024 reports 20–35% on
hardest deciles; PAWS 2019 reports 5–8% human disagreement on the full
distribution). But several known biases plausibly contribute:

| Bias | Status in our setup | Fix (ranked by ROI) |
|---|---|---|
| **Position bias** (Zheng et al. 2023, MT-Bench; Shi et al. 2024, *Judging the Judges*) | Likely present — Session A/B order is fixed. | **Swap and average**: run each pair with A/B and B/A, take majority. Cheapest known fix; kills the largest documented bias. |
| **Anchoring on the cosine value in the prompt** (Lou et al. 2024 [arXiv:2412.06593](https://arxiv.org/abs/2412.06593); ICLR HCAIR 2026 [arXiv:2505.15392](https://arxiv.org/abs/2505.15392)) | Present — and our "do not let this anchor your judgement" instruction **does not work** per both anchoring papers. | **Drop the cosine from the prompt** entirely, or randomize/perturb it across runs as an ablation. |
| **Verbosity bias** (Zheng 2023) | Plausible — longer sessions have more surface to match. | Lower priority. Consider normalizing preview length. |
| **Self-enhancement** (Panickssery 2024) | Low risk — neither judge authored the sessions. | None needed. |
| **Yes-bias on binary questions** (Zheng 2023) | Plausible — binary "is duplicate?" tilts toward yes. | Counter-anchor in rubric ("when uncertain, prefer NOT") — we already do this. |
| **Chain-of-thought before verdict** | Missing — we go direct to JSON schema. | Add a `reasoning` field that the model fills *before* the `label` field (JSON schema order matters), and instruct CoT in system prompt. Empirical 2025 work (arXiv:2506.13639) shows κ improvement. |
| **Cross-family diversity** | Haiku 4.5 + Sonnet 4.6 share a family prior — gives an **upper bound** on independence. | Add a third judge from a different family (GPT-4o-mini or Gemini Flash) for a true cross-family majority. Defer until base setup is stable. |
| **Self-consistency** vs dual-judge | Missing — single-shot per judge. | N=3 samples per model with confidence-weighted vote (CISC, ACL Findings 2025) tightens calibration. ~2-3× cost. |

**Compounded effect:** position randomization + drop cosine + CoT
would each drop disagreement 5–10 pp independently. Combined, we'd
likely see disagreement fall from 30% to 10–15%, closer to the
human-disagreement floor on hard pairs.

---

## 6. Recommended changes — ranked

### Tier 1 — factual fixes (commit-now)

1. Fix Park 2026 → Tacheny 2026 in design doc, calibration.ts header,
   duplicatesSemantic.ts comment, semanticAnalysis.ts comment.
2. Drop Katariya 2016 citation. Replace 65% with "typically 20–40%"
   sourced to Cochran 1977.
3. Trim "calibrates full high range" SemDeDup mischaracterization.
4. Reframe anisotropy paragraph in design doc (residual, not severe).

### Tier 2 — methodology corrections (small follow-up PR)

5. Switch isotonic → Platt or beta at n < 500; gate isotonic above.
6. Tighten `MIN_LABELS_FOR_FIT` to require ≥10 positives AND
   ≥10 negatives.
7. Bump `DEFAULT_P_NEAR_DUP_TARGET` from 0.5 to 0.9 (or expose
   precision target).
8. Drop cosine value from auto-labeler prompt (anchoring fix).
9. Add A/B position randomization in `scripts/auto-label-threshold.mjs`.

### Tier 3 — quality-improving follow-ups (separate PRs, not blocking)

10. CoT-first JSON schema (reasoning before label).
11. Add a third cross-family judge for true independence.
12. Active sampling on next labeling pass — fill in uncertain pairs.
13. Per-workflow-tag thresholds for heterogeneous corpus.
14. Self-consistency (N=3 per model) over current single-shot.

---

## 7. What this audit doesn't change

The pipeline shape (embed → cosine → threshold → cluster), the
auto-label-as-default decision, the `claude -p` integration, the
Wilson-CI sweep reporting, and the calibration-on-disk format are all
sound choices. The bulk of the work on PR #52 stands; Tier 1 is paper
errata and Tier 2 is methodology tuning at n=70.

## Sources

Primary:
- [Tacheny 2026, arXiv:2601.16907](https://arxiv.org/abs/2601.16907)
- [Brown/Cai/DasGupta 2001](https://projecteuclid.org/journals/statistical-science/volume-16/issue-2/Interval-Estimation-for-a-Binomial-Proportion/10.1214/ss/1009213286.full)
- [Ethayarajh 2019](https://aclanthology.org/D19-1006/) — embedding anisotropy
- [SimCSE — Gao et al. 2021, arXiv:2104.08821](https://arxiv.org/abs/2104.08821)
- [AnglE — Li & Li 2023, arXiv:2309.12871](https://arxiv.org/abs/2309.12871)
- [Niculescu-Mizil & Caruana 2005](https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf) — Platt vs isotonic
- [Beta calibration — Kull et al. 2017, AISTATS](http://proceedings.mlr.press/v54/kull17a.html)
- [SemDeDup — Abbas 2023, arXiv:2303.09540](https://arxiv.org/abs/2303.09540)
- [Zheng et al. 2023 MT-Bench, arXiv:2306.05685](https://arxiv.org/abs/2306.05685)
- [Shi et al. *Judging the Judges*, arXiv:2406.07791](https://arxiv.org/abs/2406.07791)
- [PARAPHRASUS benchmark 2024, arXiv:2409.12060](https://arxiv.org/abs/2409.12060)
- [Anchoring Bias in LLMs, arXiv:2412.06593](https://arxiv.org/abs/2412.06593)

Production pipelines:
- [NeMo Curator deduplication](https://docs.nvidia.com/nemo/curator/latest/curate-text/process-data/deduplication/)
- [HuggingFace text-dedup](https://github.com/ChenghaoMou/text-dedup)
- [BigCode / Stack MinHash blog](https://huggingface.co/blog/dedup)
- [RedPajama-v2](https://www.together.ai/blog/redpajama-data-v2)
- [Dolma — arXiv:2402.00159](https://arxiv.org/abs/2402.00159)
