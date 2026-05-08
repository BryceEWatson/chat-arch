# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project loosely follows [Semantic Versioning](https://semver.org/)
at the **exporter-data layer** (the `exporterVersion` field in
`analysis/meta.json`). Individual workspace packages are private and
stay at `0.0.0`; the exporter version is the user-facing artifact
contract.

The version label appears at the top of `analysis/meta.json` after each
rescan, so anyone inspecting a chat-arch-data bundle can correlate the
on-disk shape with this changelog.

## [Unreleased]

## [0.7.0] — 2026-05-08

### Added

- **Corrections view** — a new viewer panel that surfaces recurring
  user-corrections-to-the-AI clustered into patterns, sorted into three
  buckets (`RECURRING AFTER APPLIED`, `ALREADY ENCODED BUT FAILING`,
  `NEW PATTERNS TO ENCODE`), and paired with proposed CLAUDE.md
  upgrades. The mining pipeline runs locally via the `/mine-corrections`
  Claude Code skill — no transcript ever leaves your machine.
- **Heuristic-recall layer** — `packages/analysis` ships a pure
  pattern-detection kernel (`detectCorrectionCandidates`) that scans
  user turns for correction signals (`explicit-stop`, `explicit-no`,
  `instead-of`, `imperative-override`, `frustration`,
  `repeat-instruction`, plus the new `soft-redirect` and `want-prefer`
  families added in v0.7.0). The exporter calls it during `runAnalysis`
  and writes `analysis/correction-candidates.json`.
- **Mining API endpoints** (dev server only):
  - `POST /api/mine-corrections` — drives the LLM classification +
    clustering stages of the corrections pipeline by spawning the
    `claude` CLI against the project's `.claude/skills/mine-corrections/`
    skill. NDJSON-streamed progress.
  - `POST /api/clear-corrections` — wipes `corrections.json` and any
    orphan run-status files. Leaves `correction-candidates.json` intact.
  - Both endpoints share the same CSRF posture as `/api/rescan`:
    local-origin check + custom `X-Requested-With` header.
- **Pipeline coverage UI** — every corrections panel now shows a
  classified-vs-total ratio bar plus an expandable funnel that tracks
  sessions → transcripts → user prompts → candidates → classified →
  actionable → patterns, with a `NOT SCANNED` callout for coverage gaps
  (sessions without transcripts, sources not loaded).
- **Recall-audit script** — `scripts/audit-correction-recall.mjs`
  spot-checks how many non-firing user turns carry weak correction
  signals the heuristic doesn't capture. Used during the v0.7.0
  expansion to validate the new pattern families.
- **Heuristic-version cache key** — `correction-candidates.json` now
  carries `heuristicRecallVersion: 2` and a per-session `scanStatsBySession`
  tuple. Pattern-set changes invalidate the cache; per-session stats
  preserve funnel-counter accuracy across incremental rescans.

### Changed

- **Heuristic-recall ruleset (v2)** — broadened the explicit-no
  negation regex (matches `don't/never` + any verb, not a small
  whitelist), added `soft-redirect` (`actually,` / `wait,` / `hmm,` /
  `let's …`) and `want-prefer` (`I want / need / prefer / I'd rather /
  I would like`) families, added `just|please` to the imperative-
  override family. Measured against a single 472-session author corpus
  via `scripts/audit-correction-recall.mjs`: candidate count on that
  corpus rose from 196 → 590 (about 3×) with most lift from
  `soft-redirect`, broadened `explicit-no`, and `want-prefer`.
  Per-corpus results will vary — re-run the audit script to see your
  own numbers.
- **Corrections panel readability pass** — bumped body-text
  transparencies from the 50-82% tier to 88-95% across all paragraphs,
  notes, captions, and instance excerpts. Body font sizes nudged up by
  0.5-1px on the smallest items. Line-length capped at 78ch on
  paragraph blocks. No palette or chrome changes.
- **Status-file polling for in-flight runs** — the mining banner now
  polls `${dataDir}/analysis/correction-status-${requestId}.json` while
  a run is active, so phase / current-of-total / log lines surface in
  real time rather than waiting for the headless `claude -p` to finish.
- **In-flight attach** — when the panel mounts and detects a run is
  already in progress (page reload, second tab, prior 409), it now
  attaches to the existing run by polling its status file rather than
  surfacing a 409 error. The probe response includes `busyRequestId`.

### Performance

- **Incremental corrections scan** — the heuristic-recall pass now
  reuses prior candidates for sessions whose `updatedAt` predates the
  prior file's `generatedAt`. On the same 472-session author corpus
  used for the recall audit, a warm rescan (no sessions changed) ran
  in ~5ms vs. ~18s previously; cold rescans (after a heuristic-
  version bump or fresh corpus) ran in ~1.5s on that corpus due to
  the parallel I/O change below. These are single-machine, single-
  corpus measurements — magnitude of the speedup is what matters,
  not the specific numbers.
- **Parallel transcript I/O** — `buildCorrectionsCandidatesFile` reads
  transcripts via an 8-way worker-pool (`parallelMap`) instead of a
  serial `for await` loop. Cold rescan I/O bucket dropped ~12×.

### Documentation

- This changelog.
- README updated to describe the corrections view and the local
  mining pipeline.

[Unreleased]: https://github.com/BryceEWatson/chat-arch/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/BryceEWatson/chat-arch/releases/tag/v0.7.0
