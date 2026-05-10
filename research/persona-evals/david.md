# David — Cloud-Only Knowledge Worker — chat-arch.dev evaluation

David is a PM/researcher who has only ever used claude.ai in the browser.
He has no idea what `pnpm`, a "manifest", or `~/.claude/projects/` are.
He arrives via the **hosted** chat-arch.dev (static Cloudflare Pages
build — no `/api/rescan`, `/api/mine-corrections`, `/api/clear`,
`/api/clear-corrections`, `/api/repo-ground`, `/api/save-prompt`, or
`/api/encode-pattern` endpoints). His goal: see what his AI use
actually looks like.

This evaluation reads code only — the dev server is up but David's
experience doesn't include any of its SSR routes.

---

## 1. Landing on chat-arch.dev (cold)

### Verdict
**Solid.** The empty-state landing is the strongest part of the
product for David. SCAN LOCAL hides cleanly when `useRescan().available`
is false; the fallback copy and CTA are accurate to what he can do.

### Friction
- The empty-state heading reads `"NO DATA YET"` and the body copy
  starts `"Drop a claude.ai Privacy-Export ZIP…"`
  (`packages/viewer/src/ChatArchViewer.tsx:1873`). That's correct for
  David. But the surrounding chrome — a `TopBar` titled "CHAT
  ARCHAEOLOGIST" plus a `lcars-top-bar__earthdate` chip showing
  `2026.05.08` — leans hard into the LCARS bit before the user knows
  what the product does (`packages/viewer/src/components/TopBar.tsx:75`,
  `:101`). A first-time visitor who clicked a Twitter link doesn't yet
  have the trust to find "EARTHDATE" charming.
- The page title "Chat Archaeologist" is set in `BaseLayout`
  (`apps/standalone/src/pages/index.astro:6`) — David read about
  "chat-arch" on Twitter and now the tab title reads something
  different. Minor, but it's the kind of thing that makes him
  double-check he's on the right site.

### Suggestions
- Add a one-line subtitle under the title on the empty state: "*See
  what your Claude conversations actually add up to.*" Right now the
  trust strip handles the privacy framing but nothing on the page
  answers "what is this?" until the user reads the upload-panel hint
  (`UploadPanel.tsx:122`).
- Either rename the document title to "chat-arch" or "chat-arch —
  Claude conversation viewer" so the tab matches the URL/Twitter
  link he followed in (`apps/standalone/src/pages/index.astro:6`).

---

## 2. Privacy framing — TrustStrip / README / no-telemetry copy

### Verdict
**Strong content, slightly muted placement.** The TrustStrip text is
exactly what David needs to read. The footnote disclosing the HF
model fetch is honest in a way most products don't bother with
(`packages/viewer/src/components/TrustStrip.tsx:43-47`). But the
strip is rendered as a quiet `<aside>` between TopBar and ErrorState
(`ChatArchViewer.tsx:1887`) — visually it reads more like a status
chip than a headline pledge.

### Friction
- The TrustStrip **disappears once data is loaded**. Comment at
  `TrustStrip.tsx:27` confirms this is by design: "returning users
  don't need the re-pitch every session." But David is not a
  returning user — and the moment he uploads, he's effectively
  trusted the page. If he shows it to a coworker afterward, the
  pledge is gone and only "VIEW SOURCE ↗" survives in the sidebar
  footer.
- The CorrectionsPanel and DataPanel both contain CLI-flavored copy
  (DataPanel: "run `pnpm --filter @chat-arch/standalone dev`",
  `DataPanel.tsx:31`; "[`~/.claude/projects/`]" lists in InfoPopover
  at `:315-320`). David opens DATA out of curiosity → reads about
  filesystem paths he doesn't have → trust drops a notch ("is this
  for me?").
- The README's headline "**Local-first by construction**" is
  technically accurate, but the sentence "A local `pnpm dev` checkout
  additionally exposes a same-origin `/api/rescan` endpoint…"
  (`README.md:14-21`) lands as jargon. David clicks the chat-arch.dev
  link from the README badge and never reads the rest.

### Suggestions
- Render the TrustStrip permanently in the sidebar footer area on
  populated views, not just empty (`Sidebar.tsx:240` — there's already
  a `RepoLink` in the footer; one more compact line ("LOCAL-FIRST · No
  telemetry") would keep the pledge live).
- Move the "what is this?" sentence to the top of the README, before
  the local-first paragraph, so the chat-arch.dev visitor reading the
  homepage repo link sees product-purpose before infrastructure
  posture (`README.md:1-21`).

---

## 3. CHOOSE ZIP flow

### Verdict
**Works correctly. Filename masking is solid.** `maskedUploadLabel`
strips the email-bearing filename to `upload.zip (27.6 MB)` before any
React state or DOM render
(`packages/viewer/src/data/uploadLabel.ts:33-39`,
`UploadPanel.tsx:96-104`). The single-source-of-truth comment at
`uploadLabel.ts:14-18` is the right architectural call — covered
by `UploadPanel.test.tsx` and `uploadLabel.test.ts`.

### Friction
- The hint copy on the panel reads "Drop a Settings → Privacy →
  Export data ZIP from claude.ai to browse your conversations
  **without running the CLI**" (`UploadPanel.tsx:122-125`). For
  David, "without running the CLI" is unreadable noise — he never
  considered the CLI option in the first place. It signals "this
  product is mostly for CLI people, you're using the lesser path."
- Path to the ZIP is buried in two places: `UploadPanel.tsx:122` says
  "Settings → Privacy → Export data" (good) but the InfoPopover with
  the same instructions only appears in the populated DataPanel
  (`DataPanel.tsx:233-238`). On the empty state, no popover, no
  visual cue that the user has to **wait for an email** with the ZIP
  before they can do anything.
- The success state "LOADED 1,047 CONVERSATIONS FROM upload.zip
  (27.6 MB)" reads fine. The error state shows raw error messages
  from `fflate` (`UploadPanel.tsx:108-111`) — if David picks the
  wrong file, he sees a stack-flavored string.

### Suggestions
- Replace "without running the CLI" with "It's parsed in this tab
  — no upload, no account needed."
  (`UploadPanel.tsx:122-125`).
- Add a one-line walkthrough above the CHOOSE ZIP button: *"Don't
  have one yet? In claude.ai, click your avatar → Settings → Privacy
  → Export data, then wait for the email."* Right now the closest
  equivalent is the README, which David didn't read.
- Wrap the parse error in a friendlier framer when the message
  doesn't include `conversations.json` — a missing-file error is the
  most likely "wrong ZIP picked" case (`zipUpload.ts:39-44`
  produces a useful one; `:33-37` is fflate-flavored).

---

## 4. Post-upload sessions list

### Verdict
**Good for David.** SESSIONS grid + KPI tiles + sparkline + filter
bar is intuitive output for a PM. The session card design surfaces
project, topic chips, and "DUP/ZOMBIE" chips without explanation,
but the chips are hover-tooltipped and don't block the read.

### Friction
- The mode is labeled "SESSIONS" in the sidebar but the underlying
  internal id is `command` (`Sidebar.tsx:61`). User-facing copy is
  fine; David never sees the internal name.
- "ZOMBIE" chip language on cards (`SessionCard.tsx`) — a PM who
  hasn't read the README will read it as judgmental jargon ("am I a
  zombie?"). It's clickable into ConstellationMode and explains itself
  there, but the chip stands alone on the card.
- The sparkline + KPI tiles deliver insight quickly — "6 months,
  1,047 conversations, $0 cost" — but the Cost row will literally
  show `$0.00` for cloud-only data (the `allCloud` notice at
  `CostMode.tsx:91-101` exists but only fires inside CostMode itself,
  not on the KPI tile in `UpperPanel`).

### Suggestions
- Make the KPI cost tile dim or hide entirely when `allCloud === true`
  on the manifest, replacing it with a small "COST UNAVAILABLE FOR
  CLOUD" chip. Exposing `$0.00` reads as a bug.
  (`UpperPanel.tsx`, around the OVERVIEW tab cost KPI; needs the
  `allCloud` predicate from `CostMode.tsx:91`.)
- Consider replacing "ZOMBIE" with "DORMANT" or "STALLED" on
  cloud-only data — the original CLI framing ("project I started
  and abandoned") doesn't translate cleanly to a claude.ai user
  whose "projects" are organizational, not directories.

---

## 5. Session detail (DetailMode)

### Verdict
**Works.** Cloud drill-in renders directly from the in-memory
`uploadedConversationsById` map, no network round trip
(`DetailMode.tsx:91-99`). Prev/next nav, copy-as-markdown, all
function for David's use case.

### Friction
- The cost meta strip on detail uses `detailCostTooltip`
  (`DetailMode.tsx:47-58`), which says "No cost signal for this
  session — neither CLI logs nor an estimate are available." for
  cloud rows. That copy is honest but leaks the CLI framing.

### Suggestions
- For cloud sources, replace the cost line with a quiet "claude.ai
  doesn't expose cost for cloud conversations" rather than implying
  a missing signal (`DetailMode.tsx:55-57`).

---

## 6. TopicsMode

### Verdict
**Mostly works for David, but only after he runs ANALYZE TOPICS.**
The topic system's primary input on cloud-only data is the BGE-small
embedding pass via `AnalysisLauncher` (`UpperPanel.tsx`'s ANALYSIS
tab, `AnalysisLauncher.tsx`). The launcher's armed-preview is
genuinely good UX — it explains scope, mode, steps, runtime
(`AnalysisLauncher.tsx:288-356`). David will read it and feel
oriented.

### Friction
- Without running ANALYZE TOPICS, `TopicsMode` shows an empty state:
  "*No topics discovered in the active manifest. Run the analyzer or
  load a richer fixture to populate.*"
  (`TopicsMode.tsx:53-58`). "the analyzer" is undefined here —
  David doesn't know which analyzer or where it lives. A v1 fix
  is to point this empty state at the AnalysisLauncher / ANALYSIS
  tab.
- The 36 MB model download is gated by a click on the launcher's
  primary button which arms a preview, then a second click to start.
  That's the right shape, but for a "I'm just kicking the tires"
  user it's a lot to commit to. The download is cached after first
  run, but the *first-visit* time-to-first-topic-insight is
  download (~30s on good wifi) + embed (~1-3 min on WebGPU) = the
  product's slowest path is also its most insight-dense one.

### Suggestions
- TopicsMode empty state should link directly to the ANALYSIS
  launcher rather than to a vague "analyzer" — "*Click ANALYZE
  TOPICS in the OVERVIEW tab to discover topic clusters.*"
  (`TopicsMode.tsx:53-58`).
- Pre-render the demo data's topics in the TopicsMode empty
  state's example so David sees what the surface *can* look like
  before he commits to the embed pass. (Demo data already has
  topics — but TopicsMode doesn't render them differently from
  real ones.)

---

## 7. ProjectsMode

### Verdict
**Good when projects.json is present in the export.** A claude.ai
Privacy-Export ZIP includes projects.json for users who organized
their conversations into projects. For users who didn't (David might
not have), the surface degrades to one big `[UNASSIGNED]`
pseudo-project (`ProjectsMode.tsx:9` references
`isUnassignedProject`).

### Friction
- The empty state copy is "*No projects discovered in the active
  manifest. Upload a cloud export or scan local sources to populate.*"
  (`ProjectsMode.tsx:115-122`). David already uploaded — this copy
  reads as if his upload didn't work.
- An `[UNASSIGNED]` pseudo-project is the most likely David-case
  and the surface doesn't explain what it means.

### Suggestions
- When `projects.length === 1 && projects[0].isUnassigned`, show a
  dedicated empty state: *"You haven't organized your conversations
  into projects in claude.ai. The TOPICS view can group them by
  semantic similarity instead."* (`ProjectsMode.tsx:115-122`).

---

## 8. CommandMode + ConstellationMode + TimelineMode + CostMode

### Verdict — by mode for David
- **CommandMode (SESSIONS):** ✓ resonates — it's the "what did I
  ask?" surface.
- **TimelineMode (in-SESSIONS toggle):** ✓ resonates as a sparkline
  he can hover (`TimelineMode.tsx`).
- **CostMode:** mostly inert for David. The "CLOUD-ONLY DATA"
  notice (`CostMode.tsx:91-101`) is honest but it dominates the
  page, and three of the four sub-sections render zero data. Plus
  a `LocalAnalyzerEmpty` for `COST · DIAGNOSED`
  (`CostMode.tsx:122-129`) — see Hosted-build dead-ends below.
- **ConstellationMode (ANALYSIS):** Mixed. Exact-duplicates and
  zombie-projects are useful. But the bottom of the page is a
  `LocalAnalyzerAccordion` whose CTA ends in `pnpm analyze`
  (`LocalAnalyzerAccordion.tsx:77`,
  `LocalAnalyzerEmpty.tsx:67`).

### Friction
- ConstellationMode's `[+] UNLOCK WITH LOCAL ANALYSIS` accordion
  with three `LocalAnalyzerEmpty` children renders the literal
  string `"LOCAL ANALYZER REQUIRED — install chat-arch-analyzer
  skill and run 'pnpm analyze'."` for any visitor — hosted or dev.
  David has no skill to install, no `pnpm` to run. Dead-end CTA.
  (`LocalAnalyzerEmpty.tsx:67-68`,
  `LocalAnalyzerAccordion.tsx:87-104`,
  `CostMode.tsx:122-129`.)
- CostMode for an all-cloud manifest renders its all-cloud notice
  AND four cost panels (stacked-bar, by-model, by-project, top-20)
  AND the `LocalAnalyzerEmpty` for COST · DIAGNOSED — a four-empty
  state plus a fifth jargon-CTA. David should not see this surface
  populated this way.

### Suggestions
- **Gate `LocalAnalyzerEmpty` behind a `scanAvailable === true` /
  dev-server check** — render it only when the user has actually
  reached for `pnpm analyze` is a real next step. On hosted builds,
  hide the accordion entirely or replace the CTA with "*Available
  when running chat-arch locally — see the README.*" with a link.
  (`LocalAnalyzerEmpty.tsx:67-68`,
  `LocalAnalyzerAccordion.tsx:75-79`.)
- Alternatively, replace the hosted-build CTA with the same
  language pattern that DataPanel uses for SCAN LOCAL: clear
  "available when running locally" framing rather than imperative
  install instructions (`DataPanel.tsx:299-309`).

---

## 9. PracticeMode

### Verdict
**Pleasantly surprising for David.** The "PRACTICE" surface delivers
genuine insight without an LLM round-trip — it's mechanical findings
across four lenses (`PracticeMode.tsx:44-49`). Severity chips,
linkable evidence, no jargon. This is the closest thing to a "what
is my AI use *actually* like" insight moment.

### Friction
- The sidebar label "PRACTICE" is opaque (`Sidebar.tsx:73`). David
  doesn't know if "PRACTICE" means his practice (his use), the
  agent's practice, or something else. The lead copy in the surface
  itself is good (`PracticeMode.tsx:91-96`) but he has to click to
  get there.
- Lens names: `your-patterns`, `agent-patterns`, `process-gaps`,
  `value-leaks` (`PracticeMode.tsx:44-49`). "value leaks" reads as
  jargon for "places you're wasting time/money" — which David could
  parse, but it's not obvious on first sight.

### Suggestions
- Rename the sidebar label "PRACTICE" → "REVIEW" or "INSIGHTS" or
  "AUDIT" (`Sidebar.tsx:73`). Keep the inline title "PRACTICE" if
  the design system is committed to single-word LCARS labels.
- Add a one-sentence sidebar tooltip on hover that previews the
  surface's purpose.

---

## 10. Search (TopBar)

### Verdict
**Works.** Right-aligned, debounced, scoped to title/summary/preview
(`TopBar.tsx:60-66`). Placeholder copy is tier-aware and friendly.

### Friction
- The search disabled-state placeholder reads "exit detail view to
  search" (`TopBar.tsx:62`) — a polite UX, but David might not
  realize that detail view captures search at all. Minor.

---

## 11. Sidebar — modes David understands

### Verdict
**Mixed.** Six modes plus DATA. Comprehensible:
- `PROJECTS` ✓ (matches claude.ai concept)
- `TOPICS` ✓
- `SESSIONS` ✓
- `COST` ✓ (but mostly inert for him)

Less obvious:
- `PRACTICE` — covered above; opaque
- `CORRECTIONS` — opaque, and dead-ends for hosted (see §12)
- `ANALYSIS` (internal id `constellation`) — sounds like a generic
  word for the whole app, not a specific surface
  (`Sidebar.tsx:75`)

### Friction
- Sidebar groups are `BROWSE` and `INSIGHTS` — fine — but
  `CORRECTIONS` lives under INSIGHTS and on hosted builds it has
  almost nothing useful (see §12).

### Suggestions
- Hide `CORRECTIONS` from the sidebar when `probeMineCorrections()`
  returns null AND `corrections.json` isn't present in the dataRoot
  (the panel currently renders even on hosted builds, just empty).
  (`Sidebar.tsx:74`, `CorrectionsPanel.tsx:115-198`.)

---

## 12. CorrectionsPanel — hosted dead-end

### Verdict
**Dead-end on hosted, presented with no graceful degradation.**
The panel always loads and always shows its full chrome — header,
"CORRECTIONS" title, lead copy about "Apply manually for now"
(`CorrectionsPanel.tsx:866-882`), pipeline coverage meter (or zero
state), MINE CORRECTIONS button.

On hosted: `loadCorrectionCandidatesFile` and `loadCorrectionsFile`
both 404 → empty state with copy "*No correction candidates yet.
Run the chat-arch exporter first to populate
`analysis/correction-candidates.json`, then click MINE CORRECTIONS
above to run the LLM classification pass…*"
(`CorrectionsPanel.tsx:494-498`).

David sees: a sidebar item labeled CORRECTIONS, a panel that loads
empty, copy mentioning "the chat-arch exporter," `analysis/`
file paths, and an LLM classification pass he has no way to start.

### Friction
- `probeMineCorrections()` and `probeClearCorrections()` both
  return null/false on hosted. The panel does NOT use these to hide
  itself — `clearAvailable` only gates the Danger Zone visibility
  (`CorrectionsPanel.tsx:511-520`), not the rest of the panel.
- The MINE CORRECTIONS button is rendered via `MiningTrigger`
  (`CorrectionsPanel.tsx:473-489`) regardless of probe state. The
  `disabled` flag is computed from `autoWindow?.mode` and candidate
  count — both null on hosted — so the button shows but is disabled
  with a confusing tooltip ("Run the chat-arch exporter first to
  produce candidates.").
- All copy assumes a CLI-using user: "exporter," "skill,"
  "CLAUDE.md upgrades" (`CorrectionsPanel.tsx:870-873`).

### Suggestions (high impact)
- **When `probeMineCorrections()` returns null AND no
  corrections-data files exist, hide the entire CORRECTIONS sidebar
  item.** This is the single biggest fix for David's experience —
  the surface is meaningless to him.
  (`Sidebar.tsx:74` plus a probe-gating effect in
  `ChatArchViewer.tsx`.)
- If the project wants the surface discoverable to web visitors as
  a teaser, replace the panel body with a one-screen explainer
  ("This view requires running chat-arch locally. It mines
  recurring corrections from your CLI transcripts and proposes
  CLAUDE.md upgrades.") instead of the broken pipeline UI.

---

## 13. DataPanel — gracefully unavailable, but jargon-leaky

### Verdict
**Mostly degrades correctly.** SCAN LOCAL is shown disabled with
clear "Available when running locally" copy on hosted
(`DataPanel.tsx:29-32` + `:299-309`). The `scanAvailable` prop
gates the disabled state correctly via `useRescan().available`.

### Friction
- The InfoPopover for SCAN LOCAL on hosted says "*To enable, clone
  the repo and run `pnpm --filter @chat-arch/standalone dev`, then
  reload this page.*" (`DataPanel.tsx:303-308`). For David that's
  Mandarin — "clone," "pnpm," "filter."
- The DELETE section uses NuclearReset which renders fine when
  there's something to delete, hides when empty
  (`NuclearReset.tsx:107-117`). This part works.

### Suggestions
- Replace the hosted-build SCAN LOCAL hint with a non-developer
  alternative: "*Available in the local app — see [docs] for setup.
  For now, your claude.ai export covers cloud conversations.*"
  (`DataPanel.tsx:299-309`.)

---

## 14. NuclearReset

### Verdict
**Hard for David to find — but that's intentionally OK.** It lives
inside the DATA sidebar panel, which itself is a sidebar item not
on the empty-state landing. David won't stumble onto it. If he goes
looking for "delete my data," he'll click DATA → see DELETE… →
panel pops with checkboxes labeled by source.

### Friction
- The dropdown row labels are technical: "cli-direct," "cli-desktop,"
  "cowork" with file paths (`NuclearReset.tsx:60-85`). David has 0
  sessions for those rows, so they're greyed but visible — and they
  show paths he doesn't have on his machine. Reads as inventory of
  *Bryce's* data, not his.
- The cloud row labels work: "claude.ai (cloud)" + subtitle "cloud
  + uploaded ZIP" + explain "From claude.ai Privacy Export, or
  drag-and-dropped ZIP" (`NuclearReset.tsx:79-85`).

### Suggestions
- When all non-cloud rows have count=0, **hide them entirely** in
  the dropdown. The current behavior shows them with greyed counts
  + jargon paths, which makes the panel read as a complex multi-source
  tool when from David's POV it's a single-source tool.
  (`NuclearReset.tsx:325-353`.)

---

## 15. Design system page (`/design-system/`)

### Verdict
**Doesn't break David's experience, but he might land on it.** The
RepoLink chip in the sidebar footer points to GitHub, not to the
design system. The TopBar's "i" InfoPopover next to the title does
link to `/design-system/` (`TopBar.tsx:85-87`) — so a curious click
on the InfoPopover lands David on a page about LCARS, DTCG tokens,
and Michael Okuda
(`apps/standalone/src/pages/design-system/index.astro:50-66`).

### Friction
- `/design-system/spec.md` link is a raw markdown file — fine for
  designers, weird for a casual visitor (it'll render as plain text
  or download depending on browser).
- The page exists primarily for design-system reuse; David has no
  reason to spend time there.

### Suggestions
- The TopBar InfoPopover's "*View the walkthrough →*" link could be
  scoped to "*View the design system →*" with the qualifier "*(for
  designers — feel free to skip)*" so a non-designer realizes it's
  not the product manual. (`TopBar.tsx:81-87`.)

---

# Hosted-build dead-ends (CLI/local-only affordances visible on hosted)

These are surfaces or copy strings that render on the hosted build
but assume a developer/CLI environment. Each is a friction point
or trust-eroder for David.

| # | Surface / copy                                                                                           | File:line                                                                                |
|---|----------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| 1 | `LocalAnalyzerEmpty` CTA: *"install chat-arch-analyzer skill and run 'pnpm analyze'"*                     | `packages/viewer/src/components/LocalAnalyzerEmpty.tsx:67-68`                            |
| 2 | `LocalAnalyzerAccordion` renders 3 LocalAnalyzerEmpty children inside ANALYSIS surface unconditionally    | `packages/viewer/src/components/constellation/LocalAnalyzerAccordion.tsx:87-104`         |
| 3 | `CostMode` renders `LocalAnalyzerEmpty` for `COST · DIAGNOSED` regardless of `scanAvailable`              | `packages/viewer/src/components/modes/CostMode.tsx:122-129`                              |
| 4 | `CorrectionsPanel` renders MINE CORRECTIONS button + full pipeline UI even when `probeMineCorrections()` returned null | `packages/viewer/src/components/CorrectionsPanel.tsx:473-489, :115-198`        |
| 5 | `CorrectionsPanel` empty-state copy mentions "Run the chat-arch exporter," `analysis/correction-candidates.json` | `packages/viewer/src/components/CorrectionsPanel.tsx:494-498`                  |
| 6 | `CorrectionsPanel` lead copy refers to "proposed CLAUDE.md upgrades. Apply manually for now"              | `packages/viewer/src/components/CorrectionsPanel.tsx:870-873`                            |
| 7 | `DataPanel` SCAN LOCAL InfoPopover: *"clone the repo and run `pnpm --filter @chat-arch/standalone dev`"* | `packages/viewer/src/components/DataPanel.tsx:299-309`                                   |
| 8 | `DataPanel` lead copy includes `~/.claude/projects/` and `%APPDATA%\Claude\` paths in scan info-popover    | `packages/viewer/src/components/DataPanel.tsx:312-322`                                   |
| 9 | `EmptyState` default `message` prop: *"Run pnpm --filter @chat-arch/exporter start to produce a manifest."* — only used when caller doesn't override (e.g. `TopicsMode.tsx:53-58` overrides; `ProjectsMode.tsx:115-122` overrides) | `packages/viewer/src/components/EmptyState.tsx:23` |
| 10 | `ChatArchViewer` empty-state detail copy says "run the dev server (pnpm --filter @chat-arch/standalone dev)" when `rescanCtl.available === false`. Accurate but jargon-flavored. | `packages/viewer/src/ChatArchViewer.tsx:1872-1873`                |
| 11 | `TierSheet` body copy mentions running SCAN LOCAL and references "extended tier" / "local pass"          | `packages/viewer/src/components/TierSheet.tsx:104-117`                                   |
| 12 | `AnalysisLauncher` armed-preview note: *"If you're running Chat Archaeologist locally (not web-only), the richer local-analysis pipeline produces more detailed results from your CLI / Desktop / Cowork transcripts too…"* — at least flags itself, but reads as "you're getting the lesser tier" | `packages/viewer/src/components/AnalysisLauncher.tsx:308-316` |
| 13 | `NuclearReset` shows 3 rows with file paths and "0 sessions" counts even when those sources are unreachable on hosted | `packages/viewer/src/components/NuclearReset.tsx:60-85, :325-353`                |

The four most-impactful hosted dead-ends are #1-2 (the
`LocalAnalyzerEmpty` jargon CTA), #4-6 (the entire CORRECTIONS
surface), and #7 (DATA → SCAN LOCAL hint). The rest are paper-cuts.

---

# Top 5 Improvements ranked by impact for David

### 1. Hide CORRECTIONS sidebar item when `/api/mine-corrections` is unreachable
**Where:** `packages/viewer/src/components/Sidebar.tsx:74` (NAV
INSIGHTS group), gated on a probe done in `ChatArchViewer.tsx`.

**Why:** The current panel renders empty with copy mentioning
"the chat-arch exporter," `analysis/correction-candidates.json`, and
a disabled MINE CORRECTIONS button with a tooltip about an
"exporter." A non-developer reading this reaches one of two
conclusions: (a) "this is broken," or (b) "this isn't for me, I
don't belong here." Either way, trust drops. Hiding the surface
when there's nothing to show is the strongest single win.

### 2. Replace `LocalAnalyzerEmpty` CLI CTA with a hosted-aware variant
**Where:** `packages/viewer/src/components/LocalAnalyzerEmpty.tsx:67-68`,
plus the three callers
(`LocalAnalyzerAccordion.tsx:87-104`, `CostMode.tsx:122-129`).

**Why:** "*LOCAL ANALYZER REQUIRED — install chat-arch-analyzer
skill and run 'pnpm analyze'…*" is the most jargon-dense piece of
copy in the hosted build. It appears in **four places** across
ANALYSIS and COST. Either (a) hide entirely on hosted (probe via
`useRescan().available`), or (b) swap the CTA for "*Available when
running chat-arch locally — see the [getting started] guide.*"
mirroring the DataPanel pattern (`DataPanel.tsx:299-309`).

### 3. Pre-render demo-data topics + projects without requiring ANALYZE TOPICS click
**Where:** `packages/viewer/src/data/demoUpload.ts` (already
generates rich data), but `TopicsMode.tsx:52-58` and
`ProjectsMode.tsx:115-122` empty states force the user to run the
embed pass before they see anything.

**Why:** David's stated goal is "I wonder what my AI use actually
*looks* like." The fastest insight surface — TOPICS — currently
requires a 36 MB model download + ~1-3 min embed pass before
showing anything for *real* uploads. The demo data could
short-circuit this for the LOAD DEMO DATA path so David immediately
sees clusters, then he can decide whether to commit the embed pass
on his own data. Time-from-landing-to-first-insight goes from
~3 min to ~10 sec on the demo path.

### 4. Keep the TrustStrip live in the sidebar footer on populated views
**Where:** `packages/viewer/src/components/Sidebar.tsx:240-243`
(footer slot already exists with `RepoLink`); add a compact
single-line variant of `TrustStrip.tsx`.

**Why:** The privacy pledge disappears the moment data is loaded
(`TrustStrip.tsx:27` comment makes this explicit). David is most
likely to share the link with a coworker *after* he's seen the
populated view — and at that point, the page he'd ask his coworker
to look at has zero on-screen privacy framing. A single "LOCAL-FIRST
· No telemetry · [VIEW SOURCE ↗]" line in the sidebar footer keeps
the pledge present without re-pitching.

### 5. Replace "without running the CLI" hint copy in UploadPanel
**Where:** `packages/viewer/src/components/UploadPanel.tsx:122-125`
("*Drop a Settings → Privacy → Export data ZIP from claude.ai to
browse your conversations without running the CLI.*").

**Why:** This is the first sentence David reads on the empty-state
landing. "Without running the CLI" signals that the cloud upload is
the lesser of two paths — implying the product is mostly for CLI
users. A friendlier framing: "*Drop a Settings → Privacy → Export
data ZIP from claude.ai. We'll parse it in this tab — no upload, no
account needed.*" The same one-line change can pull double duty
documenting the privacy promise inline.

---

# What works (3-5 things David would appreciate)

1. **TrustStrip honesty.** The "*One caveat: the optional Analyze
   Topics step downloads a 36 MB embedding model from huggingface.co*"
   footnote (`TrustStrip.tsx:43-47`) is the kind of disclosure
   competing tools omit. David would notice and trust the rest of
   the page more for it.

2. **Filename masking.** `maskedUploadLabel` (`uploadLabel.ts:33-39`)
   is invisible in the happy path, but the moment David screenshots
   the viewer to share it, his email is gone. Not a marketed feature
   but exactly the kind of detail a privacy-conscious PM appreciates
   when he discovers it.

3. **AnalysisLauncher's armed preview.** `AnalysisLauncher.tsx:288-356`
   spells out scope, mode, steps, and runtime *before* the work
   starts. "*Typically 1-5 minutes on WebGPU; longer on WASM
   fallback.*" is what David needs to decide whether to commit.
   This pattern is what the CORRECTIONS panel and the
   LocalAnalyzerEmpty CTAs lack.

4. **PracticeMode delivers an insight moment.** Severity-tagged
   findings with linked evidence (`PracticeMode.tsx:104-175`),
   no LLM dependency, no ML cost. This is the closest thing to
   "what your AI use actually looks like" that the product offers
   without a model download. Worth marketing harder.

5. **NuclearReset's "nothing to delete" auto-hide.** The chip
   silently disappears when there's nothing to wipe
   (`NuclearReset.tsx:107-117`) instead of presenting a destructive
   action against an empty inventory. That's the right pattern; it
   should be applied to CORRECTIONS, the LocalAnalyzerEmpty CTAs,
   and the unused-source rows in the NuclearReset dropdown itself.

6. **The README's "Try it without installing"** section
   (`README.md:27-42`) is well-positioned. If David follows the
   chat-arch.dev link from there, the path matches what he expects.
   The first paragraph above it (the local-first disclosure) is
   the part that needs softening.

---

*End of David evaluation.*
