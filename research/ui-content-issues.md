# UI content-display issues — inventory

**Status:** in-progress (iter 2 of `/loop` self-paced run started 2026-05-27)
**Scope:** content-quality issues only (what we show, not how it's
styled). Specifically: wrapper-text leakage, raw markdown bleed,
truncation-loses-meaning, redundancy, vague placeholders, jargon
copy, missing units, citation tags as raw text, slug-vs-name
confusion.
**Out of scope:** colors, spacing, font sizing, motion, focus rings
(handled by the a11y-readability pass in `research/a11y-readability-*`).

A note on "unescaped HTML" framing — every JSX-text-child finding
below is **not** an XSS risk. React auto-escapes text. The issue
is that the *content* of those strings is wrapper markup / raw
markdown / harness boilerplate, so users see literal visible text
like `<command-args>` rendered as plain characters. The fix is
upstream (strip / unwrap before display), not output-escaping.

---

## ⭐ Cross-cutting: harness-wrapper leakage in summary contexts

The originating example from the SESSIONS surface. Same root cause
surfaces in *every* derived-summary field the codebase exposes.

**Root cause.** [preview.ts:13–20](packages/exporter/src/lib/preview.ts#L13)
takes `firstUserText` raw and only trims whitespace + slices to
200 chars. It doesn't unwrap the harness envelopes that
[personaCandidates.ts:71–90](packages/exporter/src/analysis/personaCandidates.ts#L71-L90)
already enumerates:

```
<command-message>     <command-name>          <command-args>
<system-reminder>     <task-notification>     <scheduled-task …>
<local-command-stdout> <local-command-stderr>
<bash-stdout>         <bash-stderr>
<uploaded_files>      <file>  <file_path>  <file_uuid>
Base directory for this skill:
Caveat: The messages below were generated
This session is being continued from a previous conversation
[Request interrupted by user
```

**Affected surfaces (all are *summary* contexts where wrappers are noise):**

| Surface | Site | What leaks |
|---|---|---|
| SESSIONS card preview row | [SessionCard.tsx:366](packages/viewer/src/components/SessionCard.tsx#L366) | Scheduled-task / slash-command wrappers fill the first 240 chars before any real content. `stripMarkdown` only nukes `#*\`>`, doesn't touch XML. |
| Corrections evidence excerpts | [CorrectionPatternCard.tsx:319,324](packages/viewer/src/components/CorrectionPatternCard.tsx#L319-L324) | `precedingAssistantExcerpt` + `inst.excerpt` render verbatim. |
| Curator-feed item titles/reasoning | [CuratorFeed.tsx:137,161](packages/viewer/src/components/CuratorFeed.tsx#L137-L161) | Item title + reasoning render verbatim. |
| Applied-improvements rule summary | [AppliedImprovementsSummary.tsx:310,314](packages/viewer/src/components/AppliedImprovementsSummary.tsx#L310-L314) | `ruleSummary` rendered + duplicated into `aria-label` (quote-break risk in attribute). |
| Personas page (per-project markdown) | _(needs deep-dive iter 3)_ | LLM-derived excerpts that already passed through Stage-1 may still carry wrappers. |
| Project & topic detail pages | _(needs deep-dive iter 3)_ | Session-card lists likely render same SessionCard. |

[x] fixed: Tier 1 envelope-unwrap — new `unwrapEnvelope` helper in `@chat-arch/analysis` (18 unit tests) wired into `buildPreview`, `resolveTitle` levels 2+3, `detectCorrectionCandidates` excerpts, and `personaCandidates` user-text intake. `HEURISTIC_RECALL_VERSION` bumped 2→3 so cached correction-candidates invalidate.

**Detail-pane contexts are NOT affected.** [MessageList.tsx:57](packages/viewer/src/components/MessageList.tsx#L57)
and [ContentBlock.tsx:156,205](packages/viewer/src/components/ContentBlock.tsx#L156)
render wrappers verbatim because the user is reading the *full
transcript* and the wrappers are part of the actual conversation.
Stripping there would be lossy.

**Fix shape.** Teach `buildPreview` (and/or a new
`buildExcerptDisplay` for citation contexts) to recognize
envelopes and surface the payload:

1. `<scheduled-task name="X" …>` → `↻ scheduled-task: X`
2. `<command-name>X</command-name>…<command-args>{Y}</command-args>` → `/X {Y}`
3. Leading line matches any other wrapper prefix → skip to next non-wrapper line, or `null`.

Bumps `EXPORTER_VERSION`; requires rescan.

---

## SessionCard

- [SessionCard.tsx:129–131](packages/viewer/src/components/SessionCard.tsx#L129) — `stripMarkdown` only removes `#*\`>` chars. Doesn't handle multi-char syntax: `**bold**` becomes `bold` (asterisks gone, bold text orphaned mid-sentence); `[text](url)` and reference-style links render verbatim; tables/horizontal-rules untouched. [x] fixed: stripMarkdown now collapses bold/italic/inline-code/links/reference-links/horizontal-rules/table-pipes; new test asserts `**bold**` + `[link](url)` + backtick-code all reduce to readable prose.
- [SessionCard.tsx:147](packages/viewer/src/components/SessionCard.tsx#L147) — Fallback `(no preview)` for null preview; visually indistinguishable from preview *failing to derive* (which is what wrapper-only sessions effectively are today). Both look like the user's data is broken. [x] fixed: replaced with `(transcript had no user-turn text)` — names the actual state; new test pins the new copy.
- [SessionCard.tsx:148](packages/viewer/src/components/SessionCard.tsx#L148) — `Untitled session` fallback fires for any falsy `session.title`. The data path has a `titleSource: 'fallback'` field that's already used for styling on line 357 — but the fallback string itself doesn't differentiate "AI title generation produced empty" from "transcript had no user content". [x] fixed: when `titleSource === 'fallback'` the fallback copy becomes `(no user-turn to title)`; generic empty-title sessions still render the original `Untitled session` string.
- [SessionCard.tsx:67–74 / 381](packages/viewer/src/components/SessionCard.tsx#L67-L74) — `formatTurns` returns `—→—` when both turn counts are null (instead of, e.g., a single em-dash). The arrow with two dashes reads as "no data → no data" which is confusing. [x] fixed: both-null case now renders a single em-dash; new test pins the behavior.

## MessageList / ContentBlock (transcript detail)

- [MessageList.tsx:57](packages/viewer/src/components/MessageList.tsx#L57) — Fallback `empty message` is identical for "no content blocks at all" vs. "tool_result with no text payload". Two different states, one string. [x] fixed: copy reframed as `(message has no body)` — names the actual condition (content array empty AND no fallback text). Verified by pnpm test render path; no test asserted the old string.
- [ContentBlock.tsx:207](packages/viewer/src/components/ContentBlock.tsx#L207) — `non-text result` is shown when a tool returns only non-text blocks; users can't tell whether the tool succeeded with structured data, or whether something upstream dropped the text. [x] fixed: copy reframed as `(tool returned structured data only — no text payload)` so the success/structured-data case reads as intentional rather than missing.

## EmptyState / ErrorState

- [EmptyState.tsx:30](packages/viewer/src/components/EmptyState.tsx#L30) — Default message is a literal CLI command (`pnpm --filter @chat-arch/exporter start`). Fine for local dev; surfaced on hosted/embedded contexts it's developer jargon with no actionable affordance. [x] fixed: copy reframed as "No sessions to display yet. Run SCAN LOCAL to ingest local transcripts, or upload an export ZIP below." — names two in-app affordances instead of a terminal command.
- [ErrorState.tsx:33](packages/viewer/src/components/ErrorState.tsx#L33) — Templates raw JS `error.message` into "The viewer hit an unrecoverable error: ${error.message}". When `error.message` is `Cannot read property 'x' of undefined`, the user gets jargon. [x] fixed: ErrorBoundary copy now leads with a user-facing summary ("The viewer hit an unrecoverable error and needs a refresh") and labels the JS message as "Technical detail (paste into a bug report if filing one)" so it reads as filable evidence rather than the user-facing message.

## NuclearReset

- [NuclearReset.tsx:226](packages/viewer/src/components/NuclearReset.tsx#L226) — HTTP error body sliced to 200 chars before appending to error message. Common case — a JSON error body — gets cut mid-object: `bad request: { error: 'invalid manif…`. Either parse `.error` field or quote the slice. [x] fixed: try-parse the body as `{ error: string }` first; on success surface only the `error` field; on parse failure quote the truncated slice + add `(truncated)` so a half-object can't be mistaken for valid JSON.

## FilterBar

- [FilterBar.tsx:431](packages/viewer/src/components/FilterBar.tsx#L431) — Topic chip strips a leading `~` via `p.id.slice(1)`. If a topic id legitimately starts with `~` (or if id ≠ display-name), the display goes wrong. Should use `displayName` field. [?] Topic schema's `displayName` field today carries the same `~theme` shape as `id`, so the `.slice(1)` workaround is functionally equivalent. Threading `displayName` would be a defensive refactor for a hypothetical future state where topic id and display name diverge — flagging for user judgment rather than fixing now.

## CorrectionPatternCard

- [CorrectionPatternCard.tsx:472](packages/viewer/src/components/CorrectionPatternCard.tsx#L472) — `rationale` field rendered as plain text. If rationale contains markdown (the mining LLM is free to write `**bold**`), it renders as raw asterisks. [x] fixed: rationale now flows through the shared `stripMarkdown` util (new file at `packages/viewer/src/util/stripMarkdown.ts`).

## CorrectionsPanel

- [CorrectionsPanel.tsx:611](packages/viewer/src/components/CorrectionsPanel.tsx#L611) — Mining `load.message` rendered directly (same JS-error-jargon risk as ErrorState). [?] Treating as part of Tier 3 (error-translator) — surfaces a server-side error to the user; the right move is the same `errorToUserMessage` helper, not a copy edit at this site.
- [CorrectionsPanel.tsx:1099](packages/viewer/src/components/CorrectionsPanel.tsx#L1099) — Uses `&ldquo;` / `&rdquo;` HTML entities. Encoding inconsistency — see AnalysisLauncher row. [x] fixed: all six viewer components carrying `&rsquo; / &ldquo; / &rdquo; / &mdash;` HTML entities or `’ / —` JS escapes (AnalysisLauncher / CorrectionsPanel / DataPanel / MethodologyDisclosure / DecisionsMode / InsightsMode / PracticeMode / TrustMode) normalized to raw Unicode `’ / “ / ” / —` so the source-level encoding is consistent.

## CuratorFeed

- (Covered by ⭐ cross-cutting row above.) [x] fixed: CuratorFeed title + reasoning render through the same shared `stripMarkdown` util now wired into CorrectionPatternCard, so any `**bold**` / `[link](url)` the LLM emits in those fields collapses to plain prose before render.

## OutcomeSparkline

- [OutcomeSparkline.tsx:239](packages/viewer/src/components/OutcomeSparkline.tsx#L239) — Tooltip shows raw `hovered.n` with no unit. Is it count of sessions? Count of contributing turns? Sample size? Label it. [x] fixed: tooltip header now reads `{date} · N session(s)` (pluralized) instead of `n=N`.

## AnalysisLauncher

- [AnalysisLauncher.tsx:242 vs :322](packages/viewer/src/components/AnalysisLauncher.tsx#L242) — Mixed quote encoding in same file: line 242 uses `’` (JS escape), line 322 uses `&rsquo;` (HTML entity). Both render as `'` but the inconsistency screams "two authors didn't talk". Standardize on raw Unicode `'`. [x] fixed: both forms normalized to raw Unicode (single sweep above also covered this file).
- [AnalysisLauncher.tsx:408](packages/viewer/src/components/AnalysisLauncher.tsx#L408) — `bundle.device.toUpperCase()` rendered as subtitle on stale state. Shows e.g. `WEBGPU` with no label — what is this? Device the bundle was embedded on? Add a label. [x] fixed: now reads `labeled on device WEBGPU` (added the `device` token).

## ActionItemsBanner

- [ActionItemsBanner.tsx:255](packages/viewer/src/components/ActionItemsBanner.tsx#L255) — Relative-time tier transitions are unclear: "just now" → "N min ago" → weekday name → ISO date. On the 7-day boundary, "Sunday" suddenly becomes a date string, no graceful intermediate ("last week", "2 weeks ago"). [x] fixed: added a `Nw ago` tier between 3d and 60d in the shared `formatRelative` helper. The banner consumes `formatRelative` directly, so the smoother tier applies everywhere it's used. New tests pin `1w ago` / `3w ago` / `Jan 5` (past 60d).

## DetailMissing

- [DetailMissing.tsx:10–11](packages/viewer/src/components/DetailMissing.tsx#L10) — Parenthesized `reason` (e.g., "(404)" or "(timeout)") with no context for what the reason means in this app. [x] fixed: copy now names the situation (transcript file couldn't be loaded) before the reason; reason itself is prefixed with `Reason:` so it reads as a label rather than a parenthetical.

## TranscriptList

- [TranscriptList.tsx:35](packages/viewer/src/components/TranscriptList.tsx#L35) — Fallback `empty transcript`; same dual-state ambiguity as MessageList. [x] fixed: copy reframed as `(transcript has no parsed lines)` — distinguishes empty input from parse-failure.

---

## Astro pages

Agent C found a thin set (9 issues across 6 pages). Suspect this
is *under*-reported — needs the iter-3 deep-dive especially on the
dynamic routes that render session lists / personas / narratives.

- [blog-drafts/index.astro:19](apps/standalone/src/pages/blog-drafts/index.astro#L19) — `&#123;` / `&#125;` HTML entities inside `<code>` may double-encode depending on Astro version. Worth verifying. [x] fixed: the entire empty-state copy was reframed to drop the file-path jargon (`analysis/blog-drafts/{slug}.prompt.md` / `chat-answer skill`) and surface the in-app SCAN LOCAL affordance instead; the brace entities went away as part of the rewrite.
- [blog-drafts/[slug].astro:67](apps/standalone/src/pages/blog-drafts/[slug].astro#L67) — `(no slug)` fallback for failed slug extraction. Should be impossible in normal routing — flag as a "fail-loud-not-silent" candidate. [x] fixed: copy changed to `Untitled draft` to match the SessionCard `Untitled session` convention. Genuinely-no-slug routing is still rare; "Untitled draft" reads as something rather than nothing.
- [design-system/index.astro:419](apps/standalone/src/pages/design-system/index.astro#L419) — `tokens.color.dim.$value` rendered raw. Trusted source so not a security issue; but the syntax is jargon for a design-system reader. [x] fixed: wrapped the raw token with a label ("Don't use the dim color token (…)") so readers see the syntax as a value of a named thing rather than as the message itself; appended the WCAG version of "fails AA".
- [health.astro:106](apps/standalone/src/pages/health.astro#L106) — Warning metrics rendered with no units / no context for whether the value is a ratio, count, or percentage. [x] fixed: warnings now compute an explicit `(count)` / `(percent)` suffix per kind so each value carries its unit; values that look like rates render through `fmtPct` as before.
- [personas.astro:326–334](apps/standalone/src/pages/personas.astro#L326) — Some meta-row values use `fmtDate()`, others render raw. Inconsistent. [?] Sweep of the meta rows shows all date-bearing values use `fmtDate`; the line numbers in the inventory bullet point at non-date cells. Leaving the inconsistency complaint marked `[?]` because it needs a concrete cell to be specific about.
- [playbook.astro:62](apps/standalone/src/pages/playbook.astro#L62) — Empty-state names a source file (`packages/analysis/src/detectPlaybookCandidates.ts`). Developer jargon shown to a user surface. [x] fixed: empty-state copy reframed to give an example of what the catalogue looks for ("use an adversarial review team" / "let's go back to first principles") so a casual user can self-diagnose why their corpus is empty without reading the kernel.
- [results.astro:215–223](apps/standalone/src/pages/results.astro#L215) — KPI sub-text uses domain term "windows" ("no observed windows yet") without glossary. [x] fixed: "no observed windows" → "no post-apply sessions yet · run more sessions after applying a pattern to start measuring". Replaces the jargon with the user-action that fixes the empty state.
- [results.astro:290](apps/standalone/src/pages/results.astro#L290) — Inlined threshold `≥3` (from `MIN_CLAIMS_FOR_LEADERBOARD`) shown in `<small>` with no explanation of *why* three. [x] fixed: `<small>` now wraps a `title=` tooltip ("Sessions with at least N verified claims qualify — below that the per-session pass-rate is too noisy to rank"). The threshold is still inlined; the WHY is one hover away.
- [views.astro:155](apps/standalone/src/pages/views.astro#L155) — Mode descriptions are abbreviation soup ("Config-impact ITS + knowledge-debt + reflexive") — no glossary affordance, no expansion on hover. [x] fixed: every description in the CROSS-CUTTING group rewritten to spell out the jargon (ITS → "interrupted time series", reflexive → "matched-pair contrast", etc.) while staying ≤ 1 line.

---

## Coverage gaps (driving iter 3)

The fan-out scan didn't cover these, but they're high-probability
sources of additional issues:

1. **Title-derivation path.** `agg.aiTitle` vs. `truncate(firstUserText, TITLE_FALLBACK_MAX_CHARS)` ([cli.ts:662–664](packages/exporter/src/sources/cli.ts#L662-L664)). When `aiTitle` is missing, the fallback truncates the same wrapper-text that pollutes the preview. So *titles* on scheduled-task / slash-command sessions may also be garbage.
2. **Dynamic Astro routes** — `projects/[id].astro`, `topics/[id].astro` — these likely embed the same SessionCard (so inherit cross-cutting #1), but may have their own per-page header/summary blurbs worth checking.
3. **Personas page + per-project markdown** — `personas/<id>.md` is LLM-authored and renders verbatim. Whether the LLM strips wrappers from its own quoted Evidence rows is unverified.
4. **CHAT (`/chat`) surface** — `chat-answer` skill output. Citation rendering.
5. **Sidebar / project chips on SESSIONS** — the project filter pill row visible in the screenshot. Project names sourced from where?
6. **`/api/*` JSON consumed by client code** — when the client renders error fields from these endpoints (mine-corrections, mine-decisions, etc.), do those error strings carry developer jargon?
7. **ChatArchViewer top-level mode shell** — section headings, tab labels, mode-switcher copy.
8. **AI-derived titles when transcript is purely scheduled-task** — the title generator may have nothing meaningful to summarize; what does it produce?

---

---

## Iter-3 findings (gaps #1–#8 deep-dive)

### Gap #1 + #8: Title-derivation cascade inherits the same wrapper-leak

[cli.ts:648–668](packages/exporter/src/sources/cli.ts#L648-L668) —
the title cascade is `aiTitle → lastPrompt → firstUserText →
"Untitled session"`. **Levels 2 and 3 use `truncate()` ([cli.ts:671](packages/exporter/src/sources/cli.ts#L671))
which only collapses whitespace — same wrapper-leak vector as
`buildPreview`.** In the user's current screenshot all three
CLI-DIRECT cards landed on `aiTitle` so the broken fallback is
latent, not active. Becomes a live bug for: interrupted sessions
that never reached AI-summarization, future Claude Code versions
that stop emitting `aiTitle`, and any tooling that bypasses the
`ai-title` line.

**Fix:** the same unwrap helper that fixes `buildPreview` should
be called from `resolveTitle` for levels 2 and 3. Bundles into the
same PR.

### Gap #2: Dynamic Astro routes

- [projects/[id].astro:17](apps/standalone/src/pages/projects/[id].astro#L17) — `<title>` is `Chat Archaeologist — Project ${id}` (raw slug). Users see "Project chat-arch-main" in the browser tab instead of a display name. [?] Fixing this means doing an SSR projects.json fetch in `[id].astro` — the file explicitly comments that it does NOT pre-fetch (the viewer is the canonical owner of projects.json). Threading the displayName through the SSR title is a structural change, not a copy edit; flagging for user judgment.
- [topics/[id].astro:10](apps/standalone/src/pages/topics/[id].astro#L10) — same: raw topic slug in `<title>`. [?] Same structural-change argument as projects/[id].astro above.
- [blog-drafts/[slug].astro:71–82](apps/standalone/src/pages/blog-drafts/[slug].astro#L71-L82) — empty-state names file paths (`analysis/blog-drafts/{slug}.md`, `{slug}.prompt.md`) and skill names (`Invoke the chat-answer skill in draft mode`) as remediation instructions. Developer jargon. [x] fixed: both the page-level empty state and the `isPrompt` notice were reframed to drop the file-path / skill-name jargon in favor of in-app affordances (SCAN LOCAL).
- [blog-drafts/[slug].astro:86–90](apps/standalone/src/pages/blog-drafts/[slug].astro#L86-L90) — section header "F-AUDIT VERDICT". The "F" prefix is internal chat-arch terminology (phase tag, not a meaningful initial). [x] fixed: renamed to "CLAIM-VERIFICATION VERDICT" — same meaning, no internal letter prefix.

### Gap #3: Personas page + per-project markdown

- [personas.astro:240](apps/standalone/src/pages/personas.astro#L240) — empty-state heading "Sidecar not yet written" uses internal architecture term ("sidecar" = the JSON file family). User-facing equivalent: "Personas not available yet". [x] fixed: heading is now "Personas not available yet" (verbatim from inventory's suggestion).
- [personas.astro:242–254](apps/standalone/src/pages/personas.astro#L242-L254) — empty-state body cites `analysis/personas.json`, `pnpm exporter run start`, `/mine-persona`, `analysis/persona-candidates.json` as remediation steps. Six developer-only terms in three sentences. [x] fixed: copy rewritten as one sentence pointing at SCAN LOCAL in the DATA panel; the file-path / slash-command terms are gone.
- [personas.astro:204–206](apps/standalone/src/pages/personas.astro#L204-L206) — `generatedAt` rendered as `toISOString().slice(0, 10)` — `2026-05-27` with no label. Compare with line 334 which does have a label — inconsistent. [?] Line 204 is now inside the JS, not a render path; can't identify the unlabeled-date cell from the inventory line number. Flagging for user clarification.
- [personas.astro:278, 298](apps/standalone/src/pages/personas.astro#L278) — `{p.sessionsAnalyzed} / {p.sessionsTotal} sessions` shown with no inline label. [x] fixed: reads as `analyzed N of M sessions` now — labels both halves and avoids the bare slash that scans as a ratio.
- [personas.astro:290](apps/standalone/src/pages/personas.astro#L290) — collapsible "Not yet generated ({skipped.length})" — bare integer with no qualitative cue (is 3 good? bad?). [x] fixed: now reads `Not yet generated · N project(s)` (pluralized). Names the unit — the integer is the count of *projects*, not of personas.
- [personas.astro:311](apps/standalone/src/pages/personas.astro#L311) — heading "Select a project" — no count, no sort hint. [x] fixed: heading now reads `Select a project ({generated.length} available)` and the body explains the analyzed-vs-total ratio.
- [personas.astro:316](apps/standalone/src/pages/personas.astro#L316) — error heading exposes `{activeRecord.personaPath}` — storage path leak. [x] fixed: the failure copy now says "Persona content missing" + "the markdown couldn't be loaded" — no on-disk path exposed.

### Gap #4: CHAT surface

- [ChatStreamedMessage.tsx:342](packages/viewer/src/components/modes/chat/ChatStreamedMessage.tsx#L342) — placeholder "Checking backend availability…" exposes implementation detail. User-facing equivalent: "Connecting…". [x] fixed: copy is now `Connecting…` in ChatMode.tsx (the actual file — inventory line number was stale).
- [ChatStreamedMessage.tsx:350–360](packages/viewer/src/components/modes/chat/ChatStreamedMessage.tsx#L350-L360) — error state names the route (`/api/chat-answer`) and the CLI (`pnpm dev`); references "static-only build". All three are dev-side concepts. [x] fixed: copy reframed as "CHAT IS NOT AVAILABLE IN THIS BUILD" + explains the hosted-vs-local distinction in user terms (no path / no command name). Remediation suggests cloning the repo for users who genuinely need CHAT; the rest of the demo works without it.
- [ChatStreamedMessage.tsx:390, 420–431](packages/viewer/src/components/modes/chat/ChatStreamedMessage.tsx#L390) — intent radios mix abbreviation styles: "OPPS" vs. "FIND OPPORTUNITIES" in the same control group. [x] fixed: the per-conversation pill label is now `OPPORTUNITIES` instead of `OPPS` so it matches the radio button it represents. Both labels now use the same convention.
- [CitationChip.tsx:49–53](packages/viewer/src/components/modes/chat/CitationChip.tsx#L49-L53) — visual chip shows `?` for unverified citations; aria-label says "unverified". Visual-vs-SR semantics drift; sighted users may not register `?` as "untrusted". [x] fixed: glyph swapped from `?` (reads as "I don't know") to `⚠` (reads as "warning") + `title=` tooltip names the actual state ("unverified citation — couldn't be matched to a known session"). Aria-label keeps "unverified" — same semantic, now matched visually.
- [blog-drafts/index.astro:43–46](apps/standalone/src/pages/blog-drafts/index.astro#L43-L46) — metadata row: `score 0.832 · 5 session(s) · span 14.2d · novelty 0.63 · audit 95%`. Five fields, four unit/scale problems (score on what scale? span in days but "d" suffix is ambiguous; novelty 0..1 with no `%`; "audit" 95% — of what?). [x] fixed: row now reads `discovery score N (0–1 scale) · N sessions · N days span · novelty N% (vs prior weeks) · audit N% pass-rate` — each value carries its unit + scale.

### Gap #5: Sidebar / project chips on SESSIONS

- [Sidebar.tsx:83–143](packages/viewer/src/components/Sidebar.tsx#L83-L143) — mode names "EFFECTIVENESS / INSIGHTS / TRENDS / DECISIONS" have no inline tooltips. Each requires the user to click in to learn what it shows. (Compare with the per-card chip tooltips that do exist.) [x] fixed: every NAV item now carries a `tooltip` field shown as `title=` on hover + woven into the long-form `aria-label` (e.g. `mode EFFECTIVENESS — Weekly composite-score trajectory — is your collaboration improving?`). Both sidebar variants (vertical full + horizontal mobile pill) read it. The HORIZONTAL_PILL_ORDER constant was collapsed into `NAV.flatMap(g => g.items)` so there's no second source of truth.
- [FilterBar.tsx:125](packages/viewer/src/components/FilterBar.tsx#L125) — project label `"UNKNOWN"` for falsy `s.project`. In the user's current screenshot, 382 sessions land in `UNKNOWN` — that's a *huge* bucket. The label gives no affordance to learn why, or to assign a project. Almost certainly the highest-leverage individual fix on this list. [x] fixed: UNKNOWN chip now carries a `title=` tooltip ("N sessions had no detectable project name. Causes: …") + a richer aria-label, so first-time visitors can learn the bucket's semantics without clicking in. The bucket still exists as a filterable pill; the fix is informational.
- [SourcePill.tsx](packages/viewer/src/components/SourcePill.tsx) + [types.ts SOURCE_LABEL](packages/viewer/src/types.ts) — labels `COWORK / CLI-DIRECT / CLI-DESKTOP / CLOUD` are internal source-family slugs, not user-facing names. Cold visitor has no way to know what they mean. Tooltip would unlock that without restructuring. [x] fixed: new `SOURCE_TOOLTIP` map in `types.ts` carries one-line descriptions per source. SourcePill renders `title={tooltip}` on both interactive + readonly variants; the interactive variant also folds the tooltip into its aria-label. The short LCARS-style labels stay unchanged.

### Gap #6: `/api/*` error responses + client error rendering

API endpoint side:

- [mine-corrections.ts:147](apps/standalone/src/pages/api/mine-corrections.ts#L147) — `spawn error: ${spawnError.message}` — passes raw Node error text. Windows DLL-init failures surface as `spawn error: Error: ENOENT: …spawnfile pnpm.cmd`. [x] fixed: new `translateSpawnError` helper maps `ENOENT` + `claude` to a user-facing "Install Claude Code from …" string. Other Node error codes (`EACCES`, generic `ENOENT`) get short translations as well.
- [mine-corrections.ts:150](apps/standalone/src/pages/api/mine-corrections.ts#L150) — `claude CLI exited with code ${exitCode}` — raw exit code, e.g. `139` / `0xC0000142`. [x] fixed: new `exitCodeHint` helper appends a Windows-DLL-init remediation tip for `0xC0000142`, and notes for `137` (OOM) and `139` (segfault). Test pins the DLL-init annotation.
- [mine-corrections.ts:154](apps/standalone/src/pages/api/mine-corrections.ts#L154) — fallback `(no message in status file)` — parenthetical placeholder. [x] fixed: copy now reads "no further detail recorded" as a clause inside the surrounding sentence.
- [mine-corrections.ts:168](apps/standalone/src/pages/api/mine-corrections.ts#L168) — error string contains the phrase "silent abort failure mode" — internal terminology. [x] fixed: explanation now reads "skill probably aborted before writing any progress (commonly: hit a cap-and-ask branch in headless mode, or local Ollama wasn't reachable when embeddings were needed)". Names the two real causes instead of the developer's nickname for the symptom.
- [mine-decisions.ts:205](apps/standalone/src/pages/api/mine-decisions.ts#L205) — same raw-spawn-error pattern. [?] mine-decisions.ts has its own copy of classifyOutcome that wasn't refactored alongside mine-corrections; the translator helpers live in mine-corrections.ts. Lifting them to a shared module is a structural refactor — marking `[?]` for user decision on whether to do that vs. duplicating the helpers.
- [generate-exports.ts:309](apps/standalone/src/pages/api/generate-exports.ts#L309) — `${session.id}: ${err.message}` — raw `ENOENT: no such file…` paired with session ID. [x] fixed: `ENOENT` paths translate to "a required transcript file is missing on disk"; other errors surface verbatim but with a "couldn't generate post-mortem for session N" lead.
- [generate-exports.ts:346–350](apps/standalone/src/pages/api/generate-exports.ts#L346-L350) — error string `manifest.json missing — run pnpm exporter run start first` + `composite-outcomes.json missing — analysis writer did not run yet`. Names the CLI command + an internal phase ("analysis writer"). [x] fixed: both rewritten to point at SCAN LOCAL and to say "analysis step needs to complete" rather than naming the writer.
- [clear-corrections.ts:108–109](apps/standalone/src/pages/api/clear-corrections.ts#L108-L109) — raw Node errors stringified into JSON response. [?] Same shape as mine-decisions — the translator helpers would need to move to a shared module; marking `[?]`.

Client consumption side:

- [applyCorrectionClient.ts:67](packages/viewer/src/data/applyCorrectionClient.ts#L67) — surfaces raw `Failed to fetch` (browser network-layer string, not actionable). [x] fixed: new `errorToUserMessage` helper in `packages/viewer/src/util/errorMessage.ts` translates `Failed to fetch` / `Load failed` / `NetworkError` into a backend-not-reachable message. Wired into applyCorrectionClient. 8 unit tests pin the translations.
- [applyCorrectionClient.ts:88–89](packages/viewer/src/data/applyCorrectionClient.ts#L88-L89) — falls back to `apply-correction failed (status 500)` — user sees a numeric HTTP code with no remediation. [x] fixed: HTTP-N strings now flow through `errorToUserMessage` which provides per-status hints (500 → "check the dev-server console"; 404 → "endpoint may be missing from this build"; etc.).
- [chatAnswerClient.ts:56](packages/viewer/src/data/chatAnswerClient.ts#L56) — `network error contacting /api/chat-answer: …` — leaks the route path to UI. [x] fixed: `errorToUserMessage` strips any `/api/<route>` substring from the surfaced message and replaces it with "the local backend".
- [chatAnswerClient.ts:63–70](packages/viewer/src/data/chatAnswerClient.ts#L63-L70) — `HTTP ${res.status}` shown when JSON parse fails; doesn't filter out dev-only fields if the server attached any. [x] fixed: same translator handles the HTTP-N fallback. When the server returns a structured `{ error: string }` envelope, the error field is also passed through the translator so route paths get stripped from server-supplied messages too.

### Gap #7: ChatArchViewer mode shell

(Falsified — partially covered above via Sidebar + agent A's pass.
No additional top-level shell strings worth flagging beyond what
agent A already cited for EmptyState / ErrorState / DataUpdatedBanner.)

---

## Final tally

| Category | Count |
|---|---|
| Cross-cutting (wrapper leak in summary contexts) | 1 root cause, ≥6 surfaced sites |
| SessionCard / list components | 7 |
| Detail-pane (MessageList, ContentBlock, TranscriptList) | 3 |
| Insight cards (Corrections, Curator, AppliedImprovements, Sparkline, AnalysisLauncher, ActionItemsBanner, DetailMissing) | 9 |
| Static Astro pages | 9 |
| Dynamic Astro routes + personas | 11 |
| Chat / blog-drafts surfaces | 5 |
| Title-derivation cascade | 1 (latent — shared root cause) |
| Sidebar / FilterBar / SourcePill (magic labels & internal slugs) | 3 |
| API error JSON shape | 8 |
| Client-side error rendering | 4 |
| **Total distinct sites** | **~61** |

---

## Prioritized fix tiers

**Tier 1 — single PR, highest leverage:** unwrap harness envelopes
once at the source. New helper in [packages/exporter/src/lib/preview.ts](packages/exporter/src/lib/preview.ts)
(call it `unwrapEnvelope` or fold into `buildPreview`), called from:

1. `buildPreview` (already its job — fix the leak)
2. `resolveTitle` levels 2+3 in [cli.ts:648](packages/exporter/src/sources/cli.ts#L648)
3. The corrections-instance excerpt builder (wherever it produces `excerpt` + `precedingAssistantExcerpt`)
4. The curator-feed item summary builder
5. Persona Evidence rows (Stage-1 candidate-evidence builder)

→ Bumps `EXPORTER_VERSION`. Requires rescan. Eliminates ~15–20 of
the ~61 distinct sites with one change.

**Tier 2 — copy edits, no schema change:**
- Replace developer-jargon empty-state strings (`pnpm exporter run start`, `Sidecar not yet written`, `Invoke the chat-answer skill`, `analysis writer did not run yet`) with user-facing equivalents that link to in-app actions where possible.
- Replace internal labels `UNKNOWN` (FilterBar) and source slugs `COWORK / CLI-DIRECT / CLI-DESKTOP / CLOUD` (SourcePill) with display names + tooltip.
- Replace ISO date renderings with localized format (or pair with a label).
- Replace bare integer counts with `{n} sessions` / `{n} projects` form.
- Resolve `<h1>{params.id}</h1>` patterns in dynamic routes by looking up the display name.

**Tier 3 — error-surface hardening:**
- Define an `errorToUserMessage(err, context)` helper at the `/api/*` boundary that filters JS error text → user-actionable strings, maps known Windows error codes (`0xC0000142`, `ENOENT pnpm.cmd`) into remediation tips.
- Wrap client `fetch` error catches with the same translator.

**Tier 4 — polish:** [x] all four sub-items shipped in earlier commits in this branch.
- Standardize encoding (`'` vs `&rsquo;`) across all components. [x] fixed: 10 viewer+Astro files normalized to raw Unicode `’ / “ / ” / —`.
- Add tooltips to mode names in Sidebar (`EFFECTIVENESS / INSIGHTS / TRENDS / DECISIONS`). [x] fixed: every NAV item carries a `tooltip` field; both sidebar variants render it as `title=` + into aria-label.
- Resolve abbreviation drift (`OPPS` vs `FIND OPPORTUNITIES`). [x] fixed: per-conversation pill is now `OPPORTUNITIES` (matches its radio button).
- Improve relative-time tiering on `ActionItemsBanner` 7d boundary. [x] fixed: `Nw ago` tier added to `formatRelative` between 3d and 60d.

---

## Status

- **Loop stopped** (this is the terminal iteration — further passes would surface diminishing-return polish-level findings).
- Inventory is at `research/ui-content-issues.md`.
- Ready for the user to direct the next move: pick a tier (Tier 1 is the obvious next PR), or scope down to a specific surface.
