# Tier 3 calibration follow-ups — design (not built)

Three quality-improving follow-ups identified in the
[calibration audit](calibration-audit-2026-05-19.md) §6. None block the
current pipeline; each gets its own focused PR when prioritised.

---

## 1. Active sampling for the next labeling pass

**Why.** Our first 99-pair labeling pass was stratified random — even
coverage of the cosine band. That's correct for an initial calibration
but inefficient for *refining* a fit: most label budget gets spent on
pairs whose calibrated P is already confidently 0 or 1 under the
current curve.

**Approach.** Sample the next batch by *current-curve uncertainty*:

```text
For each unlabeled pair p in band:
  pCurr = evaluateCalibration(curve, p.cos)
  uncertainty(p) = 1 − |pCurr − 0.5| * 2     // peaks at pCurr=0.5
Top-N by uncertainty → label.
```

Concretely, after the current Platt fit hits max P≈0.29 at cos=1.0,
the most uncertain pairs are at cos values where the sigmoid passes
through P≈0.5. Labeling those tightens the sigmoid faster than another
stratified pass would.

**Implementation surface.**

- `scripts/auto-label-threshold.mjs` gains a `--strategy active`
  flag (default stays `stratified`).
- New helper `sampleByCurveUncertainty(pairs, curve, n)` lives in
  `packages/analysis/src/calibration.ts` so it's also usable from the
  viewer.
- The labels file gets a `samplingStrategy: "active" | "stratified"`
  field per label so we can audit selection bias later.

**Open question.** Active sampling biases the labeled distribution
toward the decision boundary, which is exactly what makes the *fit*
more accurate but the *precision-sweep estimate* less reliable (the
labels are no longer a representative sample of in-band pairs). We
either (a) maintain two parallel label sets — one stratified for sweep
estimates, one active for fitting — or (b) report two metrics with
different validity caveats. (a) is cleaner; (b) is cheaper. Defer this
decision until the first active pass is run.

---

## 2. Per-workflow-tag thresholds

**Why.** Our corpus has heterogeneous session types (code debug,
prose writing, config debugging, exploration). The cosine distribution
differs across these — a global threshold over-prunes prose
("conversations about ideas have high lexical overlap") and
under-prunes code ("the same fix in different repos looks different
in cosine"). A single `pTarget` can't optimize for both.

**Approach.** Split the corpus by workflow tag (already produced by the
exporter's classifier), fit per-tag calibrations, dedup within tag.

```ts
// In duplicatesSemantic.ts options
interface BuildSemanticDuplicatesOptions {
  // existing: threshold, calibration, pTarget...
  perTagCalibration?: Map<string, CalibrationCurve>;
  tagOf?: (sessionId: string) => string | undefined;
}
```

When `perTagCalibration` is set, the pair filter picks the curve for
the pair's tag (defaulting to global when tags differ or are absent).
Cross-tag pairs use a fallback rule — likely "never near-duplicate"
since different workflows are categorically distinct artifacts.

**Implementation surface.**

- `scripts/fit-calibration.mjs` gains a `--per-tag` flag that fits one
  curve per tag from the labels (each label is already keyed by
  session pair; lookup the tag of each session in the manifest).
- `calibration.json` becomes one file per tag, or a top-level map.
- The exporter passes the right curve to `buildSemanticDuplicates`.

**Open question.** Per-tag fits need ≥10 labels per class *per tag* —
multiplying our 50-label floor by N tags. Probably defer until we
have ~500 labels total to support this cleanly.

---

## 3. Judge extensibility — cross-family without re-introducing API keys

**Why.** The audit flagged that Haiku 4.5 + Sonnet 4.6 share a family
prior — their dual-judge agreement is an *upper bound* on independence.
A truly cross-family judge (Gemini Flash, GPT-4o-mini, an open-weights
model via Ollama) would give a stronger agreement signal.

**Tension.** The whole point of the
[plan-usage refactor](feedback_claude_code_not_api.md) was eliminating
the separate `ANTHROPIC_API_KEY`. Bolting on `OPENAI_API_KEY` or
`GEMINI_API_KEY` re-introduces exactly the friction we removed.

**Approach.** Keep `claude -p` as the default judge spawner.
Generalize the judge config to support local (Ollama) and OpenRouter-
style routed access without per-provider keys:

```ts
// In scripts/auto-label-threshold.mjs
const JUDGES = {
  haiku:   { kind: 'claude-cli', model: 'claude-haiku-4-5-20251001' },
  sonnet:  { kind: 'claude-cli', model: 'claude-sonnet-4-6' },
  // Future:
  llama:   { kind: 'ollama',     model: 'llama3.1:70b-instruct' },
  gemini:  { kind: 'openrouter', model: 'google/gemini-2.5-flash' },
};
```

Ollama is the cleanest cross-family path because it's local — no API
key, no network. Llama 3.1 70B or DeepSeek-V3 via Ollama gives a
genuinely different model family. Cost: zero (your hardware).

OpenRouter is the fallback if local inference is too slow; it accepts
a single key for many providers, so it's still one knob even if
not zero knobs.

**Implementation surface.**

- `scripts/auto-label-threshold.mjs`: `--judges` now accepts qualified
  names like `haiku,llama@ollama,gemini@openrouter`. The default stays
  `haiku,sonnet` (existing dual-judge).
- New `spawnOllamaJudge` and `spawnOpenRouterJudge` functions mirror
  the existing `spawnClaudeJudge`. All return the same vote shape.
- Probe logic generalises: `claude --version` → `ollama list` →
  `OPENROUTER_API_KEY` env var. Skip judges whose probe fails; warn,
  continue with the rest.

**Open question.** Does a panel of 3+ judges where 2 must agree (vs
all-must-agree) handle disagreements better at scale? Worth a small
ablation when we have a third judge wired up.

---

## Priority ordering

1. **(2b re-run)** — measure whether the Tier 2b prompt fixes alone
   tighten the labels enough to make Platt useful at n=70. If yes,
   Tier 3 items are nice-to-haves and can be deferred indefinitely.
2. **(1) Active sampling** — biggest fit improvement per label dollar.
   Implement when Tier 2b re-run validates the current pipeline.
3. **(3) Cross-family judge via Ollama** — useful before scaling labels
   past 500. Cheap (local), no key burden.
4. **(2) Per-workflow thresholds** — defer to ≥500 labels; needs more
   data than we'll have soon.
