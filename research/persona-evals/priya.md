# Persona eval — Priya, the Curious Drive-By

**Persona shorthand.** Engineer with 90 seconds before standup. Clicked an HN
link to **chat-arch.dev**. Goal: bookmark, share, or close the tab. She'll click
LOAD DEMO DATA, poke at 2-3 surfaces, maybe peek at `/design-system`, and
leave. She has no claude.ai Privacy-Export ZIP in arm's reach and won't be
fetching one mid-tab.

---

## 1. Landing page (cold load)

**Files:**
- `apps/standalone/src/pages/index.astro:1-18`
- `packages/viewer/src/ChatArchViewer.tsx:1867-1902` (empty branch)
- `packages/viewer/src/components/TrustStrip.tsx:29-50`
- `packages/viewer/src/components/UploadPanel.tsx:114-212`

### Verdict
**Cautiously good — but the promise is muted.** The landing renders
`TopBar` (CHAT ARCHAEOLOGIST + InfoPopover linking to /design-system),
`TrustStrip`, an `ErrorState` titled `NO DATA YET`, then `UploadPanel`
with three buttons (`SCAN LOCAL` is hidden on chat-arch.dev because the
endpoint is dev-only — `UploadPanel.tsx:67` gates on `scanAvailable`).
What Priya sees on the live deploy is functionally just two buttons:
**CHOOSE ZIP** and **LOAD DEMO DATA**.

The first three things she'd clock in 10s:
1. The product name "CHAT ARCHAEOLOGIST" + the LCARS Star-Trek aesthetic
   (signal: "this is a project, not a product"). The retro look is
   *strongly* differentiating but doesn't tell her *what* it does.
2. The "LOCAL-FIRST" pledge in the trust strip — **this is great copy**.
   Three claims (parsed in browser / no telemetry / never leaves your
   machine) plus a `VIEW SOURCE ↗` chip right inline.
3. The **NO DATA YET** title in `ErrorState` — which reads like an error
   even though it isn't. Below it sits `LOAD DEMO DATA` as a *secondary*
   button (gray-outlined, second position; see
   `UploadPanel.tsx:156-167` and the styling note at
   `styles.css:2769`).

### Friction
- **No "what does this do?" headline** above the fold. The README opens
  with "The personal archive for your Claude conversation history" —
  that single sentence isn't on the landing page anywhere. The closest
  thing is the InfoPopover anchored to the title, but it talks about
  the *design system*, not the product (`TopBar.tsx:76-88`).
- `LOAD DEMO DATA` is the secondary CTA, not the primary. For a drive-
  by visitor without a ZIP, it should be primary. CHOOSE ZIP is useless
  to her — she literally cannot complete that path in 90 seconds.
- "NO DATA YET" reads as broken. A fresh first-load message
  ("Click LOAD DEMO DATA to explore" / "Drop your Privacy-Export ZIP")
  would be warmer than "NO DATA YET" + a paragraph of fetch-error
  detail (`ChatArchViewer.tsx:1872-1873` builds an `emptyDetail` string
  that includes README references — fine for a returning user, dense
  for a first-timer).
- **No screenshot / preview / hero image.** The landing is pure chrome
  + buttons. Priya can't form a "yes I want to see the inside" guess
  before clicking.

### Suggestions
1. Demote `NO DATA YET` to friendlier "EXPLORE WITH DEMO DATA" + add a
   one-line product description above it
   (`packages/viewer/src/components/ErrorState.tsx` consumer at
   `ChatArchViewer.tsx:1888`).
2. Promote `LOAD DEMO DATA` to primary CTA when there's no uploaded
   data (swap the `--secondary` modifier in `UploadPanel.tsx:159`).
3. Add a static screenshot of the populated SESSIONS grid to
   `index.astro` above the `<ChatArchViewer />` mount, gated on the
   empty state — give Priya something to *see* before she clicks.

---

## 2. LOAD DEMO DATA path

**Files:**
- `packages/viewer/src/data/demoUpload.ts:65-267` (fixture)
- `packages/viewer/src/ChatArchViewer.tsx:1511-1548` (`onLoadDemo`)
- `packages/viewer/src/ChatArchViewer.tsx:1976-2012` (DEMO DATA banner)

### Verdict
**This is the strongest part of the product.** The fixture is hand-
written, opinionated, and reads as plausible:
- 6 named projects with one-sentence descriptions
  (`demoUpload.ts:65-72`).
- Project titles + previews are domain-specific and varied —
  Bluefin Mobile / Prism Highlight / Ledger Dashboard / Codex Archive
  prompts read like real engineer-to-AI questions, not lorem ipsum
  (`demoUpload.ts:81-150`).
- A planted **zombie project** ("Codex Archive") that's deliberately
  silent for 200 days (`demoUpload.ts:139-149`, `ZOMBIE_BURST_CENTER` at
  `demoUpload.ts:352`).
- Two **byte-identical duplicate clusters** (SSH ProxyJump + webpack-
  in-pnpm) so the duplicate detector lights up
  (`demoUpload.ts:164-177`).
- Singletons grouped into ~9 thematic clusters (Postgres / auth /
  React / Docker / k8s / testing / observability / streaming / runtime
  — `demoUpload.ts:194-267`) so the semantic classifier can produce
  emergent topics.
- Deterministic seeded PRNG so the fixture looks identical between
  loads (`demoUpload.ts:33-43`, comment at `:30-31`).

### Friction
- **Every conversation has the same robot reply turns.** Lines 314-322
  show every non-first turn is *literally* `'Follow-up: can you expand
  on the trade-offs?'` (human) and `'Here's a summary of the key
  considerations, with an example.'` (assistant). If Priya drills into
  any single conversation she sees the same canned exchange. This
  would be the moment she goes "oh, it's all fake," because *the
  message bodies* — the headline thing in a conversation viewer —
  are templated. Strongest single weakness in the fixture.
- The DEMO DATA banner copy is slightly on-the-nose / instructional
  (`ChatArchViewer.tsx:1983-1995` — six lines of "to see your own
  Claude transcripts: click X for Y, Z for W"). For a curious visitor
  this banner says "you should leave and come back with a ZIP" rather
  than "look at all this neat stuff."
- The demo loads ~100 sessions instantly with no animation/intro —
  there's a 1500ms boot animation (`ChatArchViewer.tsx:117`) but the
  demo bypasses any "look what we found in your archive" reveal.

### Suggestions
1. Vary the canned reply turns — even 4-5 templates that interpolate
   the project name would make session detail readable
   (`demoUpload.ts:314-322`). Better: 2-3 hand-written multi-turn
   transcripts seeded into the fixture so at least the first session
   she opens has a "real" feel.
2. Soften the demo banner: lead with "100 fake conversations to
   explore" before the upgrade pitch (`ChatArchViewer.tsx:1984-1986`).
3. Consider auto-scrolling/highlighting the most "demo-able" thing
   (the RE-ASKED card showing 2 dup clusters?) on first demo load.

---

## 3. First populated screen (SESSIONS grid + KPIs)

**Files:**
- `packages/viewer/src/components/UpperPanel.tsx:285-659` (the chrome
  Priya looks at first)
- `packages/viewer/src/components/UpperPanel.tsx:604-643` (4 analysis
  summary cards: RE-ASKED / ZOMBIES / INFERRED / TOPICS)
- `packages/viewer/src/components/modes/CommandMode.tsx:34-90`
  (the grid)
- `packages/viewer/src/components/FilterBar.tsx`
- `packages/viewer/src/ChatArchViewer.tsx:1976-2012` (DEMO banner up top)

### Verdict
**Visually arresting, cognitively dense.** Everything fires at once:
TopBar (title, tier indicator, location chip, EARTHDATE, search) +
DEMO DATA banner + UpperPanel (sparkline + 4 analysis cards on the
ANALYSIS tab + tab bar + KPI tiles on OVERVIEW + AnalysisLauncher) +
FilterBar (source pills + project chips + UNKNOWN + SHOW EMPTY) +
sidebar (BROWSE: PROJECTS/TOPICS/SESSIONS; INSIGHTS: PRACTICE /
CORRECTIONS / ANALYSIS / COST; ACTIONS: DATA) + the 100-card grid.

That's roughly **20+ distinct affordances** visible simultaneously
above any single piece of content. Pretty, but no single feature reads
as *the* feature.

### Friction
- **No headline insight.** The four analysis cards (RE-ASKED, ZOMBIES,
  INFERRED, TOPICS — `UpperPanel.tsx:604-643`) are arguably the most
  interesting things in the product, but they sit on the **ANALYSIS
  tab** which is not the default — `tab` defaults to `'overview'`
  (`UpperPanel.tsx:334`). Priya lands on a list of session cards and
  KPI tiles, not on the differentiating analysis surfaces.
- The KPI tiles (top tool, top project, exact cost, output tokens) all
  show numbers — but for the demo fixture, costs are randomly synthesized
  (`demoUpload.ts:462-474` via `mulberry32`-seeded random in `[0,
  1.8]`). Astute viewers will notice prices have no relationship to
  conversation length and the "exact cost" KPI is grayed because none
  of the demo entries have `totalCostUsd`.
- The sparkline is good — it has shape (240-day window with a zombie
  burst at -200d, demo fixture intentionally produces this).
- Source pills include CHATGPT / CLAUDE CODE / CLI-DIRECT (visible in
  `design-system/index.astro:159-173`) but in the demo, all sessions
  are `cloud` source — the source filter pills do nothing on demo data
  except show one count and three zeros.

### Suggestions
1. **Default the upper panel to the ANALYSIS tab when demo data is
   loaded** so the four cards (RE-ASKED, ZOMBIES, …) are the first
   thing on screen. Drive-by users need to see the differentiator
   (`UpperPanel.tsx:334` — initial `tab` state).
2. Hide the source pills row when the manifest only has one source
   (FilterBar always renders them — see consumer in
   `ChatArchViewer.tsx:2236-2249`).
3. Consider hiding cost KPIs on a cloud-only fixture; the random-walk
   numbers are the easiest "obviously synthetic" tell.

---

## 4. Sidebar mode names

**File:** `packages/viewer/src/components/Sidebar.tsx:52-79`

### Verdict
**Mixed — three are clear, four are jargon.**

| Mode | Label | Read in 1 second? |
|---|---|---|
| `projects` | PROJECTS | ✅ |
| `topics` | TOPICS | ✅ |
| `command` | SESSIONS | ✅ |
| `practice` | PRACTICE | ❌ "practice what?" |
| `corrections` | CORRECTIONS | ⚠️ "corrections to what?" |
| `constellation` | ANALYSIS | ✅ (renamed from CONSTELLATION — good) |
| `cost` | COST | ✅ |

### Friction
- **PRACTICE** and **CORRECTIONS** read as jargon. PRACTICE is internal-
  speak for "adversarial audit" (see `PracticeMode.tsx:15-20` —
  "adversarial audit dashboard"). CORRECTIONS is "moments where you
  pushed back on the AI" but the sidebar gives no hint. Priya, with no
  context, will skip both. They might be the most strategically
  interesting features (RAG-able lessons from your own AI use!) and
  she'll never click them.
- The internal mode id `command` showing as label `SESSIONS` is fine
  for users but adds confusion for anyone scanning code (commented
  about at `Sidebar.tsx:43-46`, kept stable for "code stability").

### Suggestions
1. Rename PRACTICE → something action-y. From the spec: "adversarial
   audit", "value leaks", "process gaps". A label like `LEAKS` or
   `AUDIT` reads as "tell me what I'm doing wrong" much faster.
2. Rename CORRECTIONS → `PUSHBACKS` or `DISAGREEMENTS`. The current
   label suggests *Claude correcting you*, not the inverse.

---

## 5. Drill-down: clicking a session

**File:** `packages/viewer/src/components/modes/DetailMode.tsx`

### Verdict
**Will betray the demo.** The DetailMode renders the conversation's
messages via `MessageList` for cloud sessions. For the demo, the *first*
message is the unique preview (e.g. "Designing the CloudKit schema so
fishing-log notes sync between paired devices…") but every subsequent
turn is the canned `'Follow-up: can you expand on the trade-offs?'` /
`'Here's a summary of the key considerations, with an example.'` pair
(`demoUpload.ts:314-322`). This is the single concrete moment Priya
catches the fixture being fake.

### Suggestions
- See section 2 — vary canned turns, or hand-author 2-3 fully-formed
  fake sessions and seed them at known positions in the fixture.

---

## 6. ProjectsMode + TopicsMode

**Files:**
- `packages/viewer/src/components/modes/ProjectsMode.tsx:83-100`
- `packages/viewer/src/components/modes/TopicsMode.tsx:29-100`

### Verdict
**ProjectsMode demos OK; TopicsMode is gated behind running analysis.**

ProjectsMode shows the 6 project cards with sentiment labels (POSITIVE
/ NEGATIVE / NEUTRAL / MIXED — `ProjectsMode.tsx:55-67`), narrative
chips, last-activity. Codex Archive (the zombie) lights up nicely as a
trailing card with "200d ago" — that's a good demo moment.

TopicsMode index `topics.length === 0` shows EmptyState
(`TopicsMode.tsx:52-58`). Topics are populated by the semantic
classifier (BGE-small embedding model run in browser). Priya hasn't
clicked Analyze. She lands on **NO TOPICS YET / Run the analyzer or
load a richer fixture to populate** — bad first impression on a tab
the sidebar told her to click. If she's curious enough to click
Analyze, she gets a 36 MB Hugging Face download warning (TrustStrip
footnote `TrustStrip.tsx:43-47`) — not a 90-second-standup decision.

### Suggestions
1. Pre-compute topics into the demo fixture (run the BGE-small
   classification once at build time; ship the resulting label
   assignments alongside the fixture). The thematic clusters are
   already designed for it (`demoUpload.ts:188-193`).
2. Or: if topics are empty AND the source is demo, show a one-click
   "GENERATE TOPICS (downloads 36 MB)" instead of a vague EmptyState.

---

## 7. /design-system page

**File:** `apps/standalone/src/pages/design-system/index.astro:1-1193`

### Verdict
**This is excellent and may be the *real* headline feature for an
engineer drive-by.** Walks through palette / typography / shapes /
components / motion / port recipes — all generated from the actual
DTCG `tokens.json` (`index.astro:11-14`). Component examples use real
classes from `styles.css` and include copy-pasteable code blocks
(`index.astro:175-180`). Top nav has SPEC.MD, TOKENS.JSON, LLMS.TXT,
GITHUB links (`index.astro:24-28`).

For an HN-clicker, "this is a Star-Trek-styled retro UI you can
*fork as a token system*" is a more bookmarkable hook than "view your
Claude conversations." That distinction matters because **Priya isn't
yet a chat-arch user, but she might be a Supergraphic Panel user
tomorrow.**

### Friction
- The trust-strip footnote on the landing page (`TrustStrip.tsx:43-47`)
  doesn't link to /design-system — only the InfoPopover anchored to
  the title does (`TopBar.tsx:86`), and that's hidden behind a hover/
  click on a tiny "i".
- The spec.md / tokens.json / GitHub links from `/design-system` are
  great, but there's no *back-to-app* breadcrumb if she navigates
  there and wants to return.

### Suggestions
1. Add a visible "Built with Supergraphic Panel — view design system"
   chip on the landing page near the trust strip. Right now /design-
   system is mostly discoverable through the README and the popover.
2. Add a "← Chat Archaeologist" backlink on the design-system header.

---

## 8. README + VIEW SOURCE → GitHub

**Files:**
- `README.md:1-23` (top of README)
- `packages/viewer/src/components/RepoLink.tsx:16` (REPO_URL)

### Verdict
**Strong.** The README opens with the elevator pitch ("The personal
archive for your Claude conversation history") plus a one-paragraph
local-first explainer that maps cleanly to the trust-strip claim. The
"Try it without installing" section directly addresses Priya:

> 1. Open chat-arch.dev. 2. Click LOAD DEMO DATA … 3. Everything
>    renders client-side …

That's the on-ramp the landing page itself is missing. The "How
chat-arch compares" table (`README.md:170-177`) positions chat-arch
against ccusage (13k★), simonw/claude-code-transcripts (1.4k★), etc.
— credibility-by-association.

The VIEW SOURCE chip lands on the public repo. Bryce's GitHub profile
+ commit history + LICENSE + SECURITY.md are visible. Nothing to
embarrass.

### Friction
- README is *long* (~400 lines). For a 90-second visit, the lead
  paragraph carries the weight — the rest is reference. That's okay
  but means the *landing page* must do the elevator-pitch work since
  most drive-bys don't open the README.

---

## 9. "Come back later" affordances

### Verdict
**Adequate, not great.**
- **Bookmarkable URL:** Yes — the deep-link hash router supports
  `#projects`, `#project/<id>`, `#topics`, `#session/<uuid>`,
  `#practice` (`ChatArchViewer.tsx:92-165`). She can bookmark a
  specific demo session URL.
- **Product name:** "CHAT ARCHAEOLOGIST" sticky in the top bar. The
  bookmark in her bar will read as "Chat Archaeologist" or whatever
  Astro sets via `<BaseLayout title>` — fine.
- **Repo link:** Two visible places — `TrustStrip` inline VIEW SOURCE
  (empty state only — `TrustStrip.tsx:41`) and `Sidebar` footer chip
  (always-on once data is loaded — `Sidebar.tsx:240-242`). Mobile gets
  a horizontal-variant footer chip (`Sidebar.tsx:149-151`).
- **Share:** No share button. Hash-based deep links work but there's
  no copy-link affordance per session/project — she'd have to grab
  the URL bar manually.

### Suggestions
1. Add a tiny COPY URL chip per surface (PROJECTS detail, session
   detail) — so when she sees something interesting in the demo
   ("look at this zombie project!") she can paste it into Slack
   without selecting the URL bar.

---

## Demo-fixture critique

### Reads as plausible
- Project names (Bluefin Mobile, Prism Highlight, Ledger Dashboard,
  Relay Rebuild, SingleHop Pipeline, Codex Archive) — domain-varied,
  none feel like placeholders.
- First-message previews — hand-written, domain-aware, technically
  specific. ("WidgetKit reloads are hitting the 15-minute minimum.";
  "Module-scope pytest fixture got torn down per-test after a
  dependency-graph refactor.") `demoUpload.ts:81-267`.
- Duplicate-cluster previews — full paragraphs, not titles.
  `demoUpload.ts:164-177`.
- The zombie project gets historical timestamps that genuinely cluster
  in a 14-day burst 200 days ago (`demoUpload.ts:351-354`).
- Project descriptions explicitly carry "Demo fixture · pretend …"
  prefix — defensive but appropriate for a demo
  (`demoUpload.ts:66-71`).

### Reads as fake
- **Repeated assistant turns** — every non-first message in every
  conversation is one of two strings. (`demoUpload.ts:316-322`.) This
  is the load-bearing tell.
- **Cost figures are random** — uniform `[0, 1.80]` USD per session
  with no relationship to turn count or model. (`demoUpload.ts:466`.)
  An engineer scanning the COST tab would catch this.
- **Models assigned uniformly** — 25% chance each of Sonnet, Opus,
  Haiku, or null (`demoUpload.ts:269-274`). Real corpora are heavily
  one-model-dominant.
- **Conversation summaries are blank 60% of the time** — the other
  40% are 1 of 4 templates with `{topic}` interpolation
  (`demoUpload.ts:276-282`, sampled at `:388-392`).
- **All sessions are `source: cloud`** — the source-filter pills show
  three zeros. The sparkline is one color. The whole multi-source
  story (Claude Code CLI / Cowork / Desktop / cloud) is invisible in
  the demo.

### Single highest-leverage fixture fix
Replace lines 314-322 (`makeConversation`'s template loop) with at
least 6-8 varied templates, OR hand-author 3-5 fully-formed
multi-turn transcripts and intersperse them through the fixture.

---

## Headline-feature assessment

**Today's headline (what the UI steers toward):**
A retro LCARS-styled session list + KPI dashboard. SESSIONS is the
default mode. The OVERVIEW tab is the default upper-panel tab. So
Priya's first read is "this is a viewer for AI conversations with a
sparkline and tag pills."

**What it could be:**
The four ANALYSIS cards (RE-ASKED / ZOMBIES / INFERRED / TOPICS) plus
the CORRECTIONS surface tell a much sharper story:
> "Find the questions you've asked Claude more than once. Find the
> projects you abandoned. Find the rules Claude breaks even when
> CLAUDE.md says don't. Get patches for your CLAUDE.md."

That story is *unique to chat-arch* — the comparison table in the
README leans on it (no other tool in that table mines pushback patterns
or proposes CLAUDE.md upgrades). But the landing page surfaces zero of
it. Priya doesn't see "RE-ASKED · 2 prompts" until she's clicked LOAD
DEMO DATA *and* manually clicked the ANALYSIS tab in the upper panel.

**One-sentence-to-a-friend test today:** "It's like a Star-Trek-themed
viewer for your Claude history." Pretty, low share-rate.

**One-sentence-to-a-friend test it could be:** "Finds the rules Claude
keeps breaking in your transcripts and writes the CLAUDE.md patch for
you." High share-rate.

---

## Top 5 improvements ranked by impact on bookmark/share

1. **Lead with the unique value, not the chrome.** Above the empty-
   state CTAs, render a one-line product description: *"Find the
   questions you've asked twice, the projects you abandoned, and the
   rules Claude keeps breaking — all from your local transcripts."*
   (`apps/standalone/src/pages/index.astro:6-8` or
   `ChatArchViewer.tsx:1874-1888`.) **Cost: tiny. Impact: large.**
2. **Default the upper panel to ANALYSIS tab on demo load** so the
   RE-ASKED / ZOMBIES / INFERRED / TOPICS cards are the *first* thing
   visible after the demo populates. (`UpperPanel.tsx:334` — set
   initial `tab` to `'analysis'` when `demoMode` is true.)
3. **Vary the canned conversation turns** in `demoUpload.ts:314-322`
   so a session drill-in doesn't betray the fixture instantly. Even
   a per-project array of 4-5 plausible follow-up question/response
   pairs would suffice.
4. **Promote LOAD DEMO DATA to primary CTA** when the user has no
   uploaded data — and demote CHOOSE ZIP to secondary, since 90% of
   first-time visitors don't have a ZIP handy
   (`UploadPanel.tsx:143-167`).
5. **Rename PRACTICE / CORRECTIONS** in the sidebar to something less
   jargon-heavy — `LEAKS` and `PUSHBACKS` would tell a stranger what
   they do (`Sidebar.tsx:71-77`).

---

## What works (the things that pull her in within 30s)

1. **The trust-strip copy.** Three claims, one VIEW SOURCE link, one
   honest caveat about the HF download. It's a master-class in saying
   "this is local-first" credibly. (`TrustStrip.tsx:29-50`.)
2. **The retro LCARS aesthetic.** Distinctive enough to be memorable;
   internally-consistent enough to feel intentional. The
   `/design-system/` walkthrough means it's not just decoration —
   it's a portable token system. That's bookmark-worthy on its own.
3. **The fixture's project & prompt content.** Hand-authored,
   domain-varied, technically credible. The Codex Archive zombie
   project landing 200 days back is a genuinely satisfying demo
   moment.
4. **Hash-based deep links** mean the URL stays meaningful and
   bookmarkable as she explores (`ChatArchViewer.tsx:92-165`).
5. **The README's "Try it without installing" section** plus the
   comparison table — credibility-by-association with simonw,
   ccusage, et al. Once she clicks VIEW SOURCE she sees a serious
   project, not a hobby. (`README.md:27-42`, `README.md:168-184`.)
