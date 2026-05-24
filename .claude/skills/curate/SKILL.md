---
name: curate
description: Rank the Narratives + Patterns + knowledge-debt clusters that chat-arch has surfaced and produce a "what to look at now" feed for the PRACTICE surface. Reads the SQLite substrate via the @chat-arch/exporter/db SDK; outputs analysis/curator-feed.json. Defaults to claude -p subprocess execution (per the plan-billing convention); API-key fallback is opt-in only. STUB scaffold — full pipeline lands with F3 (curator ranker kernel) + F8 (meta-validation).
metadata:
  type: skill
  status: scaffold
  rev3-phase: F1
---

# /curate

You are the curator. chat-arch has already detected things worth attention: Narratives tagged at tier-2 (established) or tier-3 (promotable) on the confidence ladder, knowledge-debt clusters waiting for the user to install or dismiss, applied Patterns whose Closure-C watcher (Rev3-E E4+E5) has hit `holding` or `recurring`. Your job is to pick the top-K of those — across all kinds — and write them to a ranked feed the PRACTICE surface renders above the four lenses (Trust / Trends / Export — Rev3-F F9 adds the slot).

**Status: scaffold.** This SKILL.md exists so Rev3-F F3 (the curator ranker kernel) + F8 (meta-validation) have a stable invocation surface to wire into. The pipeline stages below are pinned by the plan but the kernels they call aren't built yet — running this skill today will report "kernel not yet implemented" and exit cleanly.

## When to invoke

- The user runs `/curate` (manually or via a scheduled `/loop`).
- The viewer's PRACTICE mode polls for the feed and the feed is older than `THRESHOLDS.curator.feedStaleAfterDays` (TODO: add to thresholds.ts in F3).

## Arguments

Parse from the user's message. Defaults in brackets.

- `--data-dir <path>` [defaults to `./chat-arch-data` relative to repo root]
- `--top-k <N>` [10] — number of items to surface in the feed.
- `--request-id <uuid>` [omitted] — present when invoked from the viewer; correlates status/output with the requesting UI.
- `--no-falsifier` [false] — skip the falsifier pass (F4). Useful for benchmarking the generator alone. Findings that bypass the falsifier are tagged `falsifierStatus: 'skipped-by-user'` per the Rev3-C convention.
- `--api-key-fallback` [false] — opt into `ANTHROPIC_API_KEY` if `claude --version` probe fails. OFF by default (plan-billing first; API-key is a paid fallback per `feedback_claude_code_not_api`).

## Pipeline (scaffold — F3+F4 implement)

You orchestrate four stages. Update the status file at every transition.

### Stage 0 — Setup

1. Probe `claude --version` (Rev3-F F5). If absent and `--api-key-fallback` is OFF, exit with a "claude CLI not detected — curator paused" banner state.
2. Open the SQLite substrate via `@chat-arch/exporter/db` (`getChatArchDb` from the standalone helper or a kernel-side equivalent).
3. Read the candidate set:
   - All Narratives where `confidence >= THRESHOLDS.narrativeRung.tier2` (Rev3-B B6).
   - All knowledge-debt clusters with `state = 'PENDING'` and `dismissalCount < cap` (Rev3-D D1).
   - All Patterns with `appliedToClaudeMd = true` whose watcher verdict is `recurring` or `inconclusive` (Rev3-E E4+E5, via `evaluateAppliedPatternWatcher`).
4. Write the initial status file at `${dataDir}/analysis/curator-status-${requestId}.json`.

### Stage 1 — Generator ranking (F3)

Call `rankCuratorCandidates(...)` from `packages/analysis/src/curatorRanker.ts` (TODO: F3 lands this). Returns the top-K candidates sorted by composite score:

- Tier (tier-3 > tier-2; cross-tier promotion is NOT allowed even when correlation is significant — outcome correlation is a tie-breaker WITHIN a tier only, per plan §"Outcome-correlation rendering").
- Confidence (from `narrativeRung.computeConfidence`).
- Recency.
- Outcome-correlation tag (only when |Δ|/SE ≥ `curator.outcomeCorrelationSignificance` AND `evidence.length ≥ 5`).

### Stage 2 — Falsifier verification (F4)

For each candidate, invoke `/falsify` (the sibling skill, Rev3-F F2). Drop findings whose `evidenceChain` fails the falsifier (citations don't resolve to real session turns whose content supports the claim). Findings that survive carry `falsifierStatus: 'verified'`.

If `--no-falsifier` is set, all findings are tagged `'skipped-by-user'` and surfaced unverified (audit-table-trackable).

### Stage 3 — Feed write

Write the surviving top-K to `${dataDir}/analysis/curator-feed.json` (atomic tmp-file + rename per F7 — TODO: F7 lands the helper). Shape:

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": <ms>,
  "ranAt": "<ISO-8601>",
  "items": [
    {
      "kind": "narrative" | "knowledge-debt" | "applied-pattern",
      "entityId": "...",
      "title": "...",
      "rank": <number>,
      "compositeScore": <number>,
      "falsifierStatus": "verified" | "skipped-by-user" | "unavailable",
      "reasoning": "..."
    }
  ]
}
```

### Stage 4 — Meta-validation (F8)

After every run, sample N recent verdicts and re-judge them (different model role). Wilson lower bound against `THRESHOLDS.curator.falsifierAccuracyFloor`. Surface a banner on drift.

## Plan billing posture

`claude -p` first (default; counts against plan, not API credit). `ANTHROPIC_API_KEY` honored ONLY when the user explicitly opts in via `--api-key-fallback` AND has set the env var. Off by default per `feedback_claude_code_not_api` and the plan's "API-key fallback OFF by default" rule (F6).

## Output framing

The curator's verdicts are NOT causal claims. The feed framing is:
- "Based on N supporting and M contradicting observations, this Narrative is currently at tier-X confidence."
- "This applied pattern has been holding for N sessions (Wilson 95% upper bound on recurrence rate: P%)."

Never write "this caused that." Wave 5 lint enforces the descriptive-contrast posture; pre-comply.
