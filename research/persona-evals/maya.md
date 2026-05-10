# Persona evaluation — Maya, the daily power user

Maya is a senior IC with multi-month corpus across Claude Code CLI, Desktop,
Cowork, and cloud. She self-hosts via `pnpm dev` and has hundreds-to-thousands
of sessions on disk. Today's question:

> "What corrections have piled up since last week, and is there a CLAUDE.md
> upgrade worth shipping?"

The walk below is in the same order the user requested. Every observation
cites file:line. Code was not modified.

---

## 1. Empty-state landing

**Verdict.** Clean and on-message for a first-time visitor, but Maya is
*never* a first-time visitor. The landing only renders when the manifest is
empty or errored, so for her the surface is dead — she reaches all data
actions through the DataPanel after load. As a "first day with chat-arch"
on-ramp it is fine; as a returning-user reorientation surface it does not
exist.

**Friction.**
- TrustStrip pitches local-first / no telemetry / "view source" on every
  empty render (`packages/viewer/src/components/TrustStrip.tsx:29-50`). On a
  re-visit after a wipe Maya sees the pitch again with no shortcut to "skip
  the pledge, just give me the buttons."
- The empty branch logic in `ChatArchViewer.tsx:1868-1902` only fires when
  `manifestState.status === 'error'` OR `manifest.sessions.length === 0`. A
  populated manifest jumps straight into the SESSIONS grid, so there is no
  surface that says "your last index was N days ago."
- Scan / Upload buttons are competing CTAs side-by-side
  (`UploadPanel.tsx:129-168`); on a fresh demo deploy the SCAN-LOCAL button
  is hidden behind the `scanAvailable` probe, leaving CHOOSE ZIP and LOAD
  DEMO DATA — fine, but the empty-state copy at line 1872-1873 is a wall of
  text that buries the actual CTAs.

**Suggestions.**
- When the manifest is populated AND `manifest.generatedAt` is older than ~7
  days, surface a returning-user reorientation banner above the SESSIONS
  grid: "Last indexed N days ago — UPDATE LOCAL?" Wire it into the existing
  `lcars-rescan-banner` slot used at `ChatArchViewer.tsx:2013-2032`.
- TrustStrip could render a compact pill ("LOCAL-FIRST · view source") on
  the *populated* layout's footer for ongoing reassurance without the wall
  of copy.

---

## 2. SCAN LOCAL flow

**Verdict.** Mature. The streaming NDJSON progress
(`data/rescan.ts:160-220`), structured `phase` events, and per-phase
counters (`SCANNING · COWORK 1/3` at `UploadPanel.tsx:69-80`) are exactly
the right level of detail for a power user watching her terminal anyway.
The post-scan delta banner is the standout — it reports `12 new local
sessions (1,247 total local)` rather than blindly restating totals
(`ChatArchViewer.tsx:1607-1681`). Maya gets her "was this scan worth doing"
answer in one glance.

**Friction.**
- The success banner only stays visible for 6 seconds
  (`ChatArchViewer.tsx:1686-1690`). If Maya was tabbed away running a code
  review and comes back to see the green border fade out before reading it,
  the delta is gone with no log of "what changed in the last rescan." There
  is no "rescan history" anywhere.
- The delta is a single number ("12 new"). It does not break out *which
  source* added them (cowork vs cli-direct vs cli-desktop), even though
  `priorCounts` carries that breakdown (`ChatArchViewer.tsx:1613-1619`).
  Maya often debugs which CLI she was actually in, so per-source delta
  would be more useful.
- The rescan banner persists when an error happens (good) but the success
  banner does not survive a refresh (lost on F5). For a 90s rescan she
  often hits F5 to reload the manifest; the celebratory message is gone.

**Suggestions.**
- Persist the last-rescan summary into `localStorage` and render a small
  "RESCAN · 2 min ago · 12 new" chip in the TopBar (next to EARTHDATE)
  until the next rescan. Keeps the answer to "did anything change?" visible
  for hours, not seconds.
- Expand the success message to per-source: "12 new · cowork +5,
  cli-direct +6, cli-desktop +1." The numbers are already in the
  `priorCounts` snapshot at `ChatArchViewer.tsx:1613-1619`.
- Add a low-key activity-log entry on every rescan (the
  `ActivityLogPanel.tsx` ring buffer is already wired up and ideal for
  this) so even a missed banner becomes findable history.

---

## 3. DataPanel sidebar

**Verdict.** Clean three-section layout (`DataPanel.tsx:174-345`),
state-aware labels (SCAN LOCAL → UPDATING · COWORK 1/3 → UPDATED ✓), and an
InfoPopover that doubles as documentation for "what does this button
actually scan?" (`DataPanel.tsx:293-328`). For Maya this is the canonical
home and works well.

**Friction.**
- The DELETE NuclearReset is gated by `nothingToDelete` at
  `NuclearReset.tsx:107-116`, which hides the chip on an empty manifest.
  Sane in principle, but the NuclearReset is rendered *inside* the
  DataPanel which the user only opens when there *is* data — the gate is
  defensive in a place it never fires. Not a bug, just dead code worth
  knowing about.
- The DataPanel does not show a "last indexed at" timestamp anywhere.
  `manifest.generatedAt` is in the schema (`packages/schema/src/unified.ts:300`)
  but `grep` across the viewer finds zero references that surface it to the
  user. Maya cannot tell whether the open panel reflects today's disk state
  or last week's without scrolling the SESSIONS grid for the most recent
  date.

**Suggestions.**
- Render `manifest.generatedAt` as "last indexed YYYY-MM-DD HH:MM · 3d ago"
  inside `DataPanel.tsx:196-199` (the lead paragraph slot). Same string
  could power a small chip in the TopBar.
- A keybinding (e.g. `g d` or `Cmd-Shift-D`) to open the DataPanel from
  anywhere would save Maya the mouse trip when she rescans 5 times a day.

---

## 4. Sessions list (default mode)

**Verdict.** The shared chrome is dense and useful — KPI tiles, sparkline,
source pills, project chips, GRID/TIMELINE toggle, sort dropdown
(`ChatArchViewer.tsx:2178-2235`). For Maya specifically the SORT dropdown
is the right primitive and "load 50 more" pagination
(`CommandMode.tsx:32-100`) is a defensible tradeoff over react-virtualized
at the corpus sizes she's running.

**Friction.**
- "SHOW 50 MORE (N REMAINING)" is the only way to surface tail sessions —
  no jump-to-bottom, no jump-to-week, no infinite scroll. With ~2000
  sessions Maya clicks 40 times to reach 2024-Q4
  (`CommandMode.tsx:88-99`).
- The Sparkline (`Sparkline.tsx:18-100`) renders one bar per week. At >2y
  history the bars compress to ~3px wide and the per-source coloring
  becomes hard to read. There is no zoom or pan.
- Filter precedence is unclear. Source pills + project chips + UNKNOWN +
  SHOW EMPTY + sort + free-text query is six axes; there's no "active
  filters: [...] · clear all" summary chip even though `onClearFilters`
  exists (`UpperPanel.tsx:58`). Maya can lose track of why a session she
  expected to see is missing.
- The free-text search (`data/search.ts:12-43`) is substring-only across
  title/summary/preview/cwd/project/topTools/modelsUsed. No regex, no
  field-scoped queries (`tool:WebFetch`, `project:chat-arch`), no boolean.
  For a corpus where she half-remembers a session, this is the weakest
  link.

**Suggestions.**
- Add a visible "active filters" summary line above the grid with quick
  toggles + a single CLEAR ALL pill. Wires through existing state in
  `ChatArchViewer.tsx`.
- Add a "JUMP TO" affordance on the sparkline: clicking a week-bar scopes
  the grid to that week. The bucketing already runs at
  `data/search.ts:128-148`.
- Promote field-scoped search syntax (`tool:`, `project:`, `source:`,
  `model:`) by extending `data/search.ts:filterSessions` — the field names
  match what the UnifiedSessionEntry already exposes.

---

## 5. Session detail overlay

**Verdict.** Solid. PREV/NEXT with `[`/`]` keybinding
(`DetailMode.tsx:120-149`) is the kind of detail that earns Maya's loyalty.
COPY TRANSCRIPT (`DetailMode.tsx:153-180`) and the meta strip with cost
breakdown tooltip (`DetailMode.tsx:46-58`) cover the obvious power-user
needs.

**Friction.**
- No way to mark a session "interesting" / "needs revisit" / "applied a
  CLAUDE.md rule from this." The detail view is read-only — the entire
  app's notion of state ends at "what's on disk."
- No deep-link copy from inside detail. There's a hash-based selection
  (`HASH_*` constants) but no visible "copy link" affordance for sharing
  with herself in a paste-bin or another tool.
- Detail does not surface whether this session contains a known correction
  candidate. Crossing the corrections schema (`Correction.sessionId` at
  `packages/schema/src/correction.ts:44`) into detail would let Maya read
  the correcting message in context — currently she has to bounce.

**Suggestions.**
- Add a "CORRECTIONS IN THIS SESSION" strip below the meta dl when the
  current session.id appears in any `Correction.sessionId` of the loaded
  `corrections.json`. Anchor + scroll to the correcting userTurnIndex.
- Add a "COPY LINK" chip next to COPY TRANSCRIPT (1-line addition reusing
  `window.location.href`).

---

## 6. Other modes (Command / Constellation / Timeline / Cost)

**Verdict.** Each mode is a complete feature. CommandMode pagination is
covered above. CostMode is well-structured (`CostMode.tsx:67-80`) with
section-scoped scroll-and-highlight behavior and KPI deep-links.
TimelineMode is purely presentational with per-source lanes
(`TimelineMode.tsx:38-90`). ConstellationMode handles cluster
chip-navigation and zombie-project sections
(`ConstellationMode.tsx:44-80`).

**Friction (Maya-specific).**
- TimelineMode has no zoom/pan and no aggregation — at multi-thousand-session
  corpora the dots overlap into a smear (`TimelineMode.tsx:69-80`).
- CostMode TOP-20 is hard-capped, with no "show 50 more" or filter — Maya
  cannot ask "show me only sessions over $1.00" from inside this mode.
- ConstellationMode "ZOMBIE PROJECTS" depends on Phase-7 analyzer output;
  the empty state is informative but doesn't tell Maya "to populate this,
  run X."

**Suggestions.**
- Timeline: add a click-and-drag zoom (selectable date window).
- Cost: cost-threshold filter chip ("≥ $0.10").
- Constellation: explicit "RUN LOCAL ANALYZER" CTA inside each empty
  section pointing at the same `useRescan()` machinery.

---

## 7. ProjectsMode

**Verdict.** The strongest "synthesis" surface. Narrative cards with
sentiment, evidence pills (`ProjectsMode.tsx:439-457`), and the
ENCODE-AS-PATTERN / GENERATE-CORRECTIVE-PROMPT actions
(`ProjectsMode.tsx:467-491`) are exactly the model Maya wants for
corrections too — synthesis → "ship it" in one click.

**Friction.**
- ProjectsIndex renders the entire `filtered` list at
  `ProjectsMode.tsx:194-235` with no pagination/virtualization. With many
  projects this is fine; with hundreds it'll repaint slowly.
- ProjectDetail also renders every session card eagerly
  (`ProjectsMode.tsx:337-343`). A project with 200+ sessions ships 200+
  SessionCard renders.
- The "ENCODE AS PATTERN" only exists for narratives, not for sessions
  directly. If Maya is reading a single session and wants to encode a
  one-off rule, she can't.

**Suggestions.**
- Apply the same `PAGE_SIZE = 50 · SHOW MORE` pattern from
  `CommandMode.tsx:32-100` to `ProjectsMode` index + detail session lists.
- Mirror the narrative-encoding action onto a "ENCODE FROM SESSION" menu
  on the detail header, so Maya can ship a CLAUDE.md tweak from a single
  exemplar without going through corrections-mining.

---

## 8. TopicsMode

**Verdict.** Functional but thinner than Projects. Index + detail follow
the same shape (`TopicsMode.tsx:29-145`), filter input is local-state
(`TopicsMode.tsx:93-101`), cross-project chips are clickable
(`TopicsMode.tsx:200-213`).

**Friction.**
- Same "renders everything" concern as Projects — TopicsIndex maps over
  `filtered` and emits a row per topic
  (`TopicsMode.tsx:121-144`).
- No way to *do* anything with a topic. Unlike narratives, topics carry no
  encode/generate actions. For Maya "I want to ship a CLAUDE.md hint
  about THIS topic" requires bouncing to corrections or hand-copying.
- Sort is hardcoded by `sessionIds.length desc` at `TopicsMode.tsx:94-96`.
  No "by recency" or "by emergence."

**Suggestions.**
- Add a session-count filter (`≥10 sessions`) and a sort toggle.
- Wire a "use this topic in a prompt" affordance — even just COPY-TO-CLIPBOARD
  of a templated `${topic.displayName}` string into a CLAUDE.md hint.

---

## 9. PracticeMode

**Verdict.** Conceptually perfect for Maya: a four-lens audit
(`PracticeMode.tsx:44-49`) with severity-tagged findings and clickable
evidence (`PracticeMode.tsx:118-167`). Every finding cites a session or
project — "nothing is a model judgment, everything links to evidence"
(`PracticeMode.tsx:93-96`). This is the page she wants to see first on a
weekly check-in.

**Friction.**
- No "since last visit" filter. Maya wants to see "what audit findings are
  NEW since I read this last week" — currently every load shows everything.
- No way to dismiss a finding or mark it "won't fix." If
  `your-patterns/value-leaks` cite the same five sessions for a month, she
  scrolls past them.
- No prioritization beyond severity. Two ALERTs side-by-side give no hint
  about which Maya should fix first.

**Suggestions.**
- Persist a "last-viewed audit timestamp" in `localStorage`; flag findings
  whose evidence sessions postdate it as NEW.
- Add a per-finding DISMISS button that writes to localStorage; respect on
  re-render. Optional UNDISMISS in a footer.
- Sort findings by severity then by evidence-count (more evidence = higher
  priority within severity).

---

## 10. Corrections panel + mining flow

**Verdict.** This is THE surface Maya came for, and it's both the deepest
and the most short-on-payoff. The pipeline (heuristic recall → LLM
classify → embed/cluster → propose) is present end-to-end
(`CorrectionsPanel.tsx:265-363`), the auto-window logic
(`CorrectionsPanel.tsx:135-162`) and "BACKFILL OLDER (N)" button
(`CorrectionsPanel.tsx:951-960`) handle exactly her question
("corrections since last week"), and the running-banner has elapsed +
staleness + DETACH (`CorrectionsPanel.tsx:1099-1145`). The CoverageMeter
(`CorrectionsPanel.tsx:558-639`) is excellent. **But the last 20% — going
from a pattern to a shipped CLAUDE.md upgrade — is broken.**

**Friction.**
- The APPLY button on every proposed upgrade is `disabled` and
  `aria-disabled` with the title "Apply flow not yet implemented — copy
  the patch and apply manually" (`CorrectionPatternCard.tsx:246-254`).
  COPY PATCH works, but Maya then has to (1) open the right file in her
  editor (path is shown at `CorrectionPatternCard.tsx:234`), (2) decide
  where to insert, (3) paste, (4) save, (5) ideally commit. The schema
  has `appliedAt` (`packages/schema/src/correction.ts:125`) so the
  "RECURRING AFTER APPLIED" bucket can light up post-fact, but there's
  no UI to write `appliedAt`.
- Each `Correction` carries `sessionId`
  (`packages/schema/src/correction.ts:44`), but
  `CorrectionPatternCard.tsx:158-180` renders the instance excerpts as
  inert `<p>` blocks. Maya cannot click through to the session that
  contained the correction. She gets the *what* and *where to fix* but
  not the *original context*. Verifying a proposed rule against the
  actual transcript becomes a manual ID lookup.
- Mining a fresh window takes 3-8 minutes wall-clock
  (`CorrectionsPanel.tsx:998-1003`). The progress UI is good. There is no
  scheduling — a daily/weekly cron is out of scope, but there's also no
  "always mine on rescan" toggle that would amortize the wait.
- The "ARMED" preview (`CorrectionsPanel.tsx:980-1025`) shows
  `~3-8 min wall-clock` and "Counts against your Claude Code plan usage"
  — good honesty — but no estimate of cost in dollars or token count. A
  power user about to mine 800 candidates wants to know "this is ~$2"
  not just "3-8 min."
- The DangerZone CLEAR ALL CORRECTIONS button
  (`CorrectionsPanel.tsx:768-860`) is a power tool, but there is no
  "CLEAR APPLIED ONLY" or "CLEAR PATTERNS WITHOUT NEW INSTANCES." The
  only granularity is nuclear.

**Suggestions (high impact).**
- **Implement APPLY.** A `/api/apply-correction` endpoint mirroring
  `/api/encode-pattern` (already used by ProjectsMode at
  `packages/viewer/src/data/narrativeActions.ts`) that takes
  `{ correctionId, upgrade }`, writes the patch into the target file,
  and stamps `appliedAt` on the correction. The architecture for it is
  *already there* for narratives.
- Add a "OPEN SESSION" button to each instance row in
  `CorrectionPatternCard.tsx:165-180`. Pass through `onSelectSession`
  from `CorrectionsPanel` (which has access via the host) — same model
  PracticeMode uses (`PracticeMode.tsx:140-146`).
- Show a per-pattern "APPLIED N DAYS AGO" badge next to the
  RECURRING-AFTER-APPLIED chip, sourced from
  `pattern.proposedUpgrades[].appliedAt` once writes are wired up.
- Add an opt-in "AUTO-MINE AFTER RESCAN" toggle stored in localStorage —
  if Maya rescans daily, she'd happily trade 3-8 minutes of background
  work for a corrections feed that's always fresh.
- Show estimated *cost* alongside estimated time in ArmedPreview
  (`CorrectionsPanel.tsx:996-1004`) — the candidate count × an avg
  tokens/candidate × claude pricing is a one-line addition.

---

## 11. ActivityLogPanel

**Verdict.** Right idea, underutilized. Slide-in panel
(`ActivityLogPanel.tsx:119-189`), severity-tagged entries, auto-scroll
that respects user scroll position (`ActivityLogPanel.tsx:60-89`), edge
tab when closed (`ActivityLogPanel.tsx:99-117`). Maya would use this *if*
it carried more events.

**Friction.**
- The empty-state hint enumerates "Upload a ZIP, scan local, or click
  ANALYZE TOPICS" (`ActivityLogPanel.tsx:158-162`) — those are the only
  three event sources. Mining a corrections run, the event of greatest
  interest to Maya, doesn't appear here. She has to be on the
  CORRECTIONS surface to see mining progress.
- No filter / search inside the log. With 500 entries the only way to
  find "the failed scan from yesterday" is to scroll.
- No persistence across reloads — the ring buffer is in-memory.

**Suggestions.**
- Pipe the corrections-mining stream events
  (`mineCorrectionsClient.ts:startMineCorrections`) through the same log
  sink. One-line wiring per event type.
- Add a tail-N filter input and a severity-only toggle.
- Persist the log buffer to localStorage with a 7-day TTL.

---

## 12. Search affordance

**Verdict.** Sound but minimal — debounced free-text input
(`ChatArchViewer.tsx:237-414` for the debounce path; `TopBar.tsx:106-122`
for the input). Substring across a useful set of fields
(`data/search.ts:19-42`).

**Friction.** Covered in §4 (no field-scoped operators, no regex, no
boolean). Maya half-remembers "the session where I asked about WebFetch
in the chat-arch repo last month" — she can search `WebFetch` but cannot
combine it with `project:chat-arch` to scope further.

**Suggestions.** Promote field-scoped syntax in
`data/search.ts:filterSessions`. Even `field:value` substring matching
without regex would be a major QoL bump.

---

## 13. NuclearReset

**Verdict.** Best-in-class destructive UX. Source-by-source checkboxes
with counts (`NuclearReset.tsx:60-85`, `NuclearReset.tsx:326-353`),
two-step "ARE YOU SURE?" arming (`NuclearReset.tsx:363-371`), and an
explicit explainer for *what each source even is* doubling as
documentation (`NuclearReset.tsx:60-85`). The IDB+localStorage cleanup
order is documented inline (`NuclearReset.tsx:218-278`).

**Friction.** Genuinely none for Maya specifically. The dropdown self-
hides on empty data, which she'll appreciate.

**Suggestions.** Optionally surface a "EXPORT BEFORE DELETING" affordance
— one-click ZIP-and-download of `chat-arch-data/` before the wipe — but
this is a nice-to-have, not a bug.

---

## 14. /bench dev-only page

**Verdict.** Correctly gated by `import.meta.env.DEV` and a runtime
redirect for safety in prod (`apps/standalone/src/pages/bench.astro:33-35`).
The dev-only memo at `bench.astro:1-28` is good documentation.

**Friction.** None for Maya in normal use. As a dev-only surface it's
out-of-band of her daily workflow.

**Suggestions.** Out of scope for this persona.

---

## Top 5 improvements ranked for Maya

1. **Implement APPLY for corrections** — `CorrectionPatternCard.tsx:246-254`
   + new `/api/apply-correction` endpoint mirroring
   `apps/standalone/src/pages/api/encode-pattern.ts`. The single change
   that turns the corrections surface from "passive list" to "shipped
   workflow." `appliedAt` is already in the schema
   (`packages/schema/src/correction.ts:125`); the bucketing logic at
   `CorrectionsPanel.tsx:60-94` already lights up RECURRING-AFTER-APPLIED
   automatically once writes happen.

2. **Click-through from correction instance to source session** —
   `CorrectionPatternCard.tsx:165-180`. Each `Correction` already has
   `sessionId`; the host already has `onSelectSession` plumbing
   (PracticeMode uses it at `PracticeMode.tsx:140-146`). Without this,
   Maya cannot verify a rule against its original context in <3 clicks.

3. **Surface "indexed N days ago" reorientation** — `manifest.generatedAt`
   exists (`packages/schema/src/unified.ts:300`) but is referenced zero
   times in the viewer's UI code. Render it as a TopBar chip or a
   conditional banner near `ChatArchViewer.tsx:2013-2032` when older than
   ~7d. Closes Maya's first-question loop ("am I looking at fresh data?")
   without forcing her into the DataPanel.

4. **Field-scoped search syntax** —
   `packages/viewer/src/data/search.ts:12-43`. Adding
   `tool:`/`project:`/`source:`/`model:` prefixes to the existing
   substring matcher is ~30 lines of code and converts the search input
   from "find that one keyword" to "actually navigate the corpus."

5. **Per-source rescan delta + persistent banner / activity-log entry** —
   `ChatArchViewer.tsx:1607-1681`. The data is already in `priorCounts`
   (line 1613-1619); split the delta phrase by source and persist into
   the activity log + a `localStorage`-backed TopBar chip. Maya tabs
   between terminals, and a 6-second toast does not survive her workflow.

---

## What works — keep these

- **Rescan delta reporting** — `ChatArchViewer.tsx:1607-1681` already
  reports "12 new local sessions" rather than restating totals; this is
  the kind of detail that makes returning users feel seen.
- **Streaming rescan progress** — NDJSON phase events
  (`data/rescan.ts:160-220`) + per-phase counters in the button label
  (`UploadPanel.tsx:69-80`) match a power-user mental model exactly.
- **CoverageMeter on the corrections panel** —
  `CorrectionsPanel.tsx:558-757` answers "how much of the archive has
  been analyzed for this view?" with a funnel that reads "transcripts →
  prompts → candidates → classified → actionable → patterns." This is
  literal pipeline observability and Maya will love it.
- **Auto-window + BACKFILL OLDER button** —
  `CorrectionsPanel.tsx:135-162` and `951-960`. Recognises the two
  natural mining cadences without ceremony.
- **NuclearReset's source-by-source pick-list** —
  `NuclearReset.tsx:60-85` and `326-353`. A destructive surface that
  doubles as documentation for "what data does this app even see?" is
  rare and worth defending.
- **PracticeMode evidence-pill clickthrough** —
  `PracticeMode.tsx:118-167`. The "every finding cites evidence,
  evidence is a button" pattern is exactly what corrections needs to
  copy.
