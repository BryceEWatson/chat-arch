# Persona evaluation — Sam, the Returning Forgetter

Sam self-hosted chat-arch ~3 months ago, ran one local index, and walks away. Today he opens `localhost:4323` (or boots `pnpm dev` on 4324) and asks: "What was I working on? What changed since I left?" His IndexedDB still holds his cloud upload. The on-disk `manifest.json` still points to a corpus from 3 months ago. Nothing on disk has changed.

This evaluation walks his journey surface by surface and audits whether the product *signals staleness*, *rewards re-orientation*, and *protects him from accidental destruction*.

---

## Surface 1 — The opening view (manifest exists + non-empty, stale)

**Verdict — borderline. He lands on a chrome-heavy SESSIONS grid sorted by recent, but with zero "you're seeing 3-month-old data" signal.**

### What he actually sees

`ChatArchViewer.tsx:219-229` initializes `mode` from URL hash; absent a hash, the default is `'command'` — which the rest of the app calls SESSIONS. So he lands on the SESSIONS GRID with:

- TopBar (`TopBar.tsx:71-104`): title, tier indicator, location chip "SESSIONS", **today's** EARTHDATE (`TopBar.tsx:69, 101-103`) — note the date displayed is *today*, not the manifest's `generatedAt`.
- UpperPanel "OVERVIEW" tab (`UpperPanel.tsx:483-487`): KPI strip + sparkline. The sparkline + RANGE chip (`UpperPanel.tsx:411-413`) show the corpus date span (e.g. `2023-08-12 → 2026-02-08`) — but this is **the date span of conversations in the corpus**, not "when this index was generated".
- MidBar with SORT default = `recent` (`ChatArchViewer.tsx:246`, `MidBar.tsx`). Sessions land sorted by `updatedAt desc` so his most-recent-touched sessions are top-left of the grid.
- FilterBar with project pills + emergent topics row.

### Friction

- Today's EARTHDATE next to a 3-month-old corpus is **actively misleading** — the "current" feel of the chrome makes the data feel fresh. There is no "AS OF …" anywhere.
- The sparkline ends in February (whenever his last session was) but the chart title is just "weekly session volume" (`Sparkline.tsx:191`). A returning user does not read "no recent bars in this sparkline" as "your data is stale" — he reads it as "I haven't been chatting with Claude lately".
- Sessions are sorted RECENT, so his top-left card is dated `Feb 8` (his last session). That's a recency cue but not framed as "this is also the manifest's last write".

### Suggestions

- Render `manifest.generatedAt` (`packages/schema/src/unified.ts:300`) somewhere persistent — TopBar, UpperPanel stats row, or as a chip beside RANGE. Suggested copy: `INDEXED 92d ago` (using `formatRelative` from `util/time.ts:30`).
- Consider a one-shot welcome banner when `Date.now() - manifest.generatedAt > 30d` AND the user hasn't visited in this browser session: "Your index is 3 months old — RE-SCAN to catch up."

---

## Surface 2 — Indications of staleness

**Verdict — almost entirely missing for the manifest itself; AnalysisLauncher and CorrectionsPanel each have isolated staleness UI but they don't add up to a returning-user story.**

### Where staleness surfaces today

- `AnalysisLauncher.tsx:380-411`: a STALE badge + "N new sessions since the last run" subtitle on the FINDINGS tab. **But** this is gated on `bundle.analyzedSessionIds` vs current cloud session ids — it only fires for the in-browser semantic analyzer, not for "your manifest is old". And it is buried under the OVERVIEW/FINDINGS tab toggle, which Sam will never click on his first re-orientation.
- `CorrectionsPanel.tsx:1085-1132`: a `staleness` field shown only **while a mining run is in flight** ("updated 12s ago" relative to last status-file write). Not a re-orientation signal.
- `CorrectionsPanel.tsx:875-879`: the corrections Header shows `Generated <ISO timestamp>` — but only on the CORRECTIONS surface, and as raw ISO, not relative ("3mo ago").
- `TierSheet.tsx:140-141`: per-file `generatedAt` shown when the user pops the tier indicator. Hidden behind a chip click.
- `UploadPanel`'s upload chip shows ZIP size, not "uploaded N days ago" (`UpperPanel.tsx:416-441`).

### What's missing

Nothing on the SESSIONS landing surface tells Sam how old his manifest is. The exporter writes `manifest.generatedAt` (`packages/schema/src/unified.ts:300`, `packages/exporter/...` writes `Date.now()`), but the viewer reads it for type purposes only — see `ChatArchViewer.tsx:1217` (sets it on synthetic uploaded manifests) and `data/fetch.test.ts:6` (test fixture). **There is no `useMemo`/render path in `ChatArchViewer.tsx` or `UpperPanel.tsx` that surfaces it.**

### Suggestions

- Add a STALENESS chip to `UpperPanel.tsx`'s stats row (next to RANGE, line 408-414). Copy: `INDEXED 92d ago` with hover tooltip showing the ISO timestamp. Color the chip warning-yellow when `>30d` and danger-red when `>90d`.
- Hoist the AnalysisLauncher `STALE` pattern into a viewer-wide banner when `(Date.now() - manifest.generatedAt) > 30d` — same persistent banner mechanism as `rescanBanner` (`ChatArchViewer.tsx:2013-2032`), reading "Index is 3 months old · RE-SCAN" with a primary action button.
- The "boot" animation logic (`ChatArchViewer.tsx:370-400`) is gated on `BOOT_SEEN_KEY` — already a per-browser-once flag. A parallel "stale-banner-seen-this-session" flag would let the warning show once and dismiss without re-nagging.

---

## Surface 3 — UPDATE LOCAL flow

**Verdict — the *delta phrasing* is well-designed (the best returning-user touch in the product), but the discoverability is poor and the success banner only stays for 6 seconds.**

### What works (`ChatArchViewer.tsx:1607-1681`)

- Pre-rescan snapshot of per-source counts (line 1613-1619), then post-rescan delta computation (line 1630-1642).
- Honest copy variants: `"12 new local sessions"`, `"3 local sessions removed"`, `"no new local sessions"` (line 1637-1642).
- Delta + duration + new total: `"Rescan complete in 4.2s · 12 new local sessions (847 total local)"` (line 1643).
- Banner + toast, with auto-dismiss only for `ok` (errors persist until ✕ click, line 1686-1690). This is correct.

### Friction

- **The button is buried.** Sam has to (a) notice the sidebar `DAT/DATA` item (`Sidebar.tsx:207-232`), (b) open the panel, (c) click `UPDATE LOCAL`. Returning users won't think "I bet there's a panel". TopBar used to host the action but v2 deliberately moved it (`TopBar.tsx:8-23`); the result is that the most-rewarding action is now two clicks deep.
- **6-second auto-dismiss is too short** for a returning user reading "12 new local sessions" — that line is the entire reward. Sam glances at the screen, looks down to read, looks back, and the banner is gone (`ChatArchViewer.tsx:1686-1690` clears at 6000ms).
- **No "what's new" surface** after the rescan. The banner says "12 new", but there's no link/button to "show me those 12". Sam must mentally re-orient by sorting RECENT and trusting the top-N rows are the new ones.
- The empty case ("no new local sessions") reads as anticlimactic — there's no "your last activity was X days ago" framing to tell him he simply hasn't been chatting.

### Suggestions

- Either keep RESCAN in the TopBar (regress the v2 D4 decision) or auto-prompt the panel open when manifest is stale (`>30d`).
- Lengthen success banner to ~15s, or until the user clicks elsewhere — the message has more information density than typical toasts.
- Make the banner clickable: clicking "12 new local sessions" sets `sortBy = 'recent'`, scrolls SESSIONS to top, and visually highlights the top-12 rows for a few seconds.
- For empty deltas: include "Last session was Feb 8 (92 days ago)" in the no-new-sessions copy.

---

## Surface 4 — Sessions list (KPI tiles + sparkline + filter bar)

**Verdict — recent-first sort is the right default; sparkline is excellent but doesn't say "you stopped here"; KPI strip is cost-focused, not activity-focused.**

### What works

- Default SORT = `recent` (`ChatArchViewer.tsx:246`, `data/search.ts:62-78`), persisted in localStorage so a returning user sees the same ordering they left.
- Sparkline shows weekly session volume + peak + avg (`Sparkline.tsx:100-200`); a 3-month gap of empty buckets at the right edge would visually telegraph "you stopped chatting" — but only if Sam interprets that gap.
- SessionCard uses relative time (`util/time.ts:30-50`): cards say "92d ago" / "Feb 8" instead of raw timestamps, which helps recency parsing.

### Friction

- The KPI strip (`UpperPanel.tsx:485-543`-ish) is cost/token/tool-focused: TOTAL COST, OUTPUT TOKENS, TOP TOOL, TOP PROJECT. None of these answer "what was I working on lately" — they're aggregate-over-corpus metrics. Three-month-stale cost is the same number as today's cost, so the user gets no "since last visit" reward.
- No "RECENT WEEK" / "LAST 7 DAYS" filter pill — Sam who wants to see "what did I do recently" must eyeball the grid and trust the sort.
- The sparkline tooltip surfaces per-bucket counts on hover but doesn't call out the latest week vs the all-time peak.

### Suggestions

- Add a "LAST 7 DAYS" / "LAST 30 DAYS" quick-filter chip to the FilterBar (or the SORT dropdown could gain a "RECENT 7d" option).
- Surface a "LATEST: Feb 8" or "STOPPED: 92d ago" annotation on the right edge of the sparkline, anchored to the last non-empty bucket.
- Replace one KPI tile (or add a fifth) with "RECENT" — sessions in last 7 days, click → filters to that window.

---

## Surface 5 — Sidebar mode-switcher

**Verdict — the default mode is `command` (SESSIONS), which is reasonable but not optimal for re-orientation. PROJECTS would be a stronger default for a returning user.**

### Layout (`Sidebar.tsx:52-79`)

```
BROWSE       INSIGHTS      ACTIONS
PROJECTS     PRACTICE      DATA
TOPICS       CORRECTIONS
SESSIONS     ANALYSIS
             COST
```

PROJECTS sits above SESSIONS in the BROWSE group (intentionally — see comment line 56-58: "narratives live on projects, so PROJECTS is where users land for insights about how their work is going"). But the *default mode* is SESSIONS (`ChatArchViewer.tsx:228`), contradicting the IA's stated priority.

### Friction

- The sidebar puts PROJECTS first visually but the default-on-load is the third entry. A returning user who scans the sidebar reads "PROJECTS · TOPICS · SESSIONS" but lands on SESSIONS — the implicit message of the IA ordering is "PROJECTS is the primary surface" but the bootstrap state contradicts that.

### Suggestions

- Either default to `mode = 'projects'` for users with non-empty `analysis/projects.json` (the v2 spec's intent), or keep SESSIONS as default but make PROJECTS visually less primary in the sidebar order.
- A fully-resolved approach: a "WELCOME BACK" landing for users whose last visit was >30d ago — see Surface 13 below.

---

## Surface 6 — ProjectsMode

**Verdict — strong re-orientation surface IF projects.json was generated; sorted by `lastActivityAt desc` so the top row IS the project Sam last touched.**

`ProjectsMode.tsx:165-174` sorts real projects by `lastActivityAt desc`, with `[UNASSIGNED]` pinned last. Each row shows `last 92d ago` (line 228, via `lastActivityRelative` line 69-81 — this is one of the few places in the viewer that writes "Nmo ago" / "Ny ago" for spans >30d).

### Friction

- The "last activity" relative time is *per-project*, not "since you last looked at chat-arch". Sam can't tell which projects had activity *since his last visit*. There's no "NEW SINCE 92d" indicator.
- If `projects.json` is empty (analysis never ran in his stale dataset, since the corrections + topics tier-2 runs require manual triggering), this surface degrades to `<EmptyState>` "NO PROJECTS YET" — a frustrating welcome.
- No "I've been working on X lately" callout — just a sorted list. He has to read 5-10 rows to absorb the picture.

### Suggestions

- Highlight projects whose `lastActivityAt > now - 30d` with a "RECENT" badge.
- Group rows: "Active recently (last 30d)" / "Older". Visual chunking.

---

## Surface 7 — TopicsMode

**Verdict — sorted by session-count, not recency. Useless for re-orientation as it stands.**

`TopicsMode.tsx:94-96` sorts by `sessionIds.length desc`. Sam's most-frequent topic over 3 years dominates; his most-recent topic doesn't surface unless it happens to be high-volume.

### Suggestions

- Add a sort toggle: count vs most-recent. Or add a "ACTIVE LAST 30d" filter.

---

## Surface 8 — CommandMode + TimelineMode + CostMode

### CommandMode (`CommandMode.tsx`)
- The grid renders sessions in the order it receives them (already sorted by `recent` from the parent). No "since last visit" reward.

### TimelineMode (`TimelineMode.tsx`)
- Lane chart by source. The right edge is the most recent activity. **A 3-month gap visually shows up here** — the cluster of dots ends in February. This is one of the better visual returning-user signals, but Sam must (a) toggle GRID → TIMELINE in the MidBar (`ChatArchViewer.tsx:2192-2213`), and (b) know to read the gap. No annotation.

### CostMode (`CostMode.tsx`)
- All-time aggregate. Doesn't answer "what changed since last visit".

### Suggestions

- Annotate the timeline's right edge: "Latest: Feb 8 (92d ago)" + dotted vertical line at "today" so the gap is read as data, not as the chart's edge.

---

## Surface 9 — Search (TopBar)

**Verdict — substring search is broad (title + summary + preview + cwd + project + tools + models per `data/search.ts:12-43`), but doesn't help "I half-remember a thing in February".**

Sam typing `"the migration thing"` works **only** if those literal words appear in title/summary/preview. There's no semantic search, no date-scoped search ("February"), no "since 2026-01-01" qualifier.

### Suggestions

- Honor `before:`/`after:` operators in the query. E.g. `migration after:2026-01-01`.
- If the embed pipeline is already loaded (he ran semantic analysis once), reuse the BGE embeddings for semantic search.

---

## Surface 10 — CorrectionsPanel

**Verdict — Sam would NOT see a returning-user reward here unless he knows to navigate to CORRECTIONS and re-run mining. The panel doesn't tell him "N new corrections accumulated since last mining run".**

### What's there (`CorrectionsPanel.tsx`)

- Header shows `Generated <ISO>` (line 875-879) — raw timestamp, not relative.
- `MiningTrigger` (line 895-970) shows "AUTO WINDOW · Nd · M candidates" or "no new candidates" (line 920-924).
- Mining is gated on `candidateCount` from the heuristic, which itself only refreshes when the exporter rescans (so a stale manifest gives stale candidates).

### Friction

- No top-of-panel banner reading "5 new candidates since you last mined" — Sam has to read the AUTO WINDOW row to figure that out.
- The "no new candidates" idle state reads correctly but doesn't explain *why* there are no new candidates ("because your manifest is 92 days old — try RE-SCAN first"). The two systems (rescan + mining) have no cross-reference in the UI.

### Suggestions

- When `manifest.generatedAt < corrections.generatedAt - 30d`, show a one-liner: "Manifest is older than corrections; re-scan first" with a RE-SCAN button.

---

## Surface 11 — NuclearReset (accidental-destruction risk)

**Verdict — well-defended via the two-step armed-then-confirm pattern AND auto-hidden when counts are zero. But the `DELETE…` chip is rendered as a full sidebar peer to other modes, which feels too visible for a "delete my data" action.**

### Defenses in place (`NuclearReset.tsx`)

- Self-hides when all source counts are 0 (line 108-116). A returning Sam **with data** sees the chip. A wiped-state Sam doesn't.
- Two-step confirm: first click sets `phase='armed'`, button label becomes `"YES — DELETE 12"` (line 187-195, 291-297). Second click commits.
- Editing checkboxes in armed state re-disarms (line 179-180, 184-185) — good.
- "Are you sure?" copy with consequence summary (line 364-371): "This wipes 12 sessions and regenerates analysis files on the next scan. It cannot be undone."
- Cache-busts the post-wipe reload (line 281-283).
- All-cloud-derived IDBs wiped together via `Promise.allSettled` (line 257-261, matches CLAUDE.md guidance).

### Friction

- The DATA panel (`DataPanel.tsx:334-343`) renders the DELETE section AS A PEER to UPLOAD/SCAN. A user opening DATA to re-scan sees three sections — UPLOAD CLOUD, SCAN LOCAL, **DELETE …** — at equal visual weight. The destructive section should be visually de-emphasized (collapsed accordion, "Advanced" footer, or a separate confirmation surface).
- The DELETE button label `DELETE…` (line 311) and the panel button `DELETE SELECTED` are uppercase-LCARS-style, which matches the rest of the chrome — but that means destructive actions look the same as `UPDATE LOCAL` / `LOAD ✓`. No visual hierarchy says "this one is dangerous".
- `lcars-top-bar__source-btn--destructive` peach-styled chip is the only visual differentiation; on first glance it reads as "another colored button" rather than "warning".
- If Sam clicks `DELETE…` purely out of curiosity, the dropdown opens with all checkboxes off. Good. But the dev-comment at lines 13-32 is correct that the dropdown also "doubles as the viewer's documentation of its own data sources" — so curious clicks are *expected*. Risk is low IF the user reads the panel before checking boxes.

### Where the risk lives

The biggest risk is **muscle memory misclick**: Sam opens DATA panel for SCAN LOCAL, his cursor lands one row too low, hits DELETE…, and is now in the dropdown. The dropdown is non-modal; clicking outside closes it (line 144-153). If he's quick and unobservant, he could check `[x] cloud` and click `DELETE SELECTED` (label includes count, so he sees `DELETE SELECTED (847)`) → button arms → clicks again → gone. Two clicks total, both with affirmative-styled labels.

### Suggestions

- Move DELETE to a separate "Danger zone" foldout at the bottom of the DATA panel, collapsed by default with a "Show advanced" / "Delete data ▸" toggle.
- For the all-selected case (`DELETE EVERYTHING`), require typed confirmation — "type DELETE to confirm" — even though the dev-comment at line 20-22 reasons against this. The all-everything path is the irreversible one; bureaucracy is appropriate.
- Render the armed-button state in red (currently `lcars-delete-dropdown__primary--armed` modifier exists — verify it has danger styling in `styles.css`).

---

## Surface 12 — ActivityLogPanel

**Verdict — pure session-scoped log, NOT a "you did X recently" timeline. Useless for re-orientation.**

`ActivityLogPanel.tsx`: in-memory ring buffer, `useActivityLog` hook is initialized empty on every page load (line 1-28 description). After Sam's reload it shows "No activity yet" until he triggers something.

### Suggestion

- This is fine for what it is (a runtime activity console). Don't repurpose it. A "your timeline" surface should be a separate view — see Suggestion below for a "WELCOME BACK" landing.

---

## Surface 13 — Empty-state copy after accidental data wipe

**Verdict — sets him up to recover but with cold-start framing, no "we still know your old data exists somewhere" hint.**

`ChatArchViewer.tsx:1867-1901`: empty manifest path renders TrustStrip + ErrorState "NO DATA YET" + UploadPanel (with onScanLocal when local available). Copy at line 1872-1873 explains the three paths (upload ZIP / scan local / load demo).

### Friction

- After `NuclearReset`, the page reloads with `?_reset=<ts>` (`NuclearReset.tsx:281-283`). The viewer strips this and renders the empty state. There is **no acknowledgment** that the user just performed a destructive action. He gets the same empty state a fresh-clone user gets. Bug-recovery framing ("Just deleted by mistake? Re-scan to rebuild local data") would be valuable.

### Suggestions

- Persist a `chat-arch:last-reset-at` timestamp in localStorage (it's a `chat-arch:*` key but NuclearReset only wipes those when `allSelected` — line 267-278). Set it on every wipe. If `Date.now() - lastResetAt < 5min`, show a "JUST DELETED — re-scan to rebuild your local index" banner above the empty state.

---

## Staleness audit — surfaces that *could* show "last indexed" but don't

| Surface | File:line | Could show | Currently shows |
|---|---|---|---|
| TopBar EARTHDATE | `TopBar.tsx:101-103` | manifest.generatedAt | TODAY's date — actively misleading |
| UpperPanel stats row (next to RANGE) | `UpperPanel.tsx:408-414` | "INDEXED 92d ago" | RANGE chip (corpus span) only |
| MidBar | `MidBar.tsx` / `ChatArchViewer.tsx:2178-2235` | last-scan timestamp | mode label only |
| DataPanel header | `DataPanel.tsx:183-199` | "Last scanned 92d ago" near UPDATE LOCAL | "Add chat data, refresh, or delete" lead copy |
| UPDATE LOCAL button caption | `DataPanel.tsx:286-291` | "Last 92d ago" | hint copy / running phase only |
| Sidebar | `Sidebar.tsx` | DAT pill could badge "STALE" | no temporal info |
| AnalysisLauncher idle states | `AnalysisLauncher.tsx:380-411, 414-444` | bundle.generatedAt relative | "STALE" / "DONE" by id-set comparison only |
| CorrectionsPanel header | `CorrectionsPanel.tsx:875-879` | "Mined 3mo ago" | raw ISO timestamp |
| TierSheet | `TierSheet.tsx:140-141` | already shows ISO; should also show relative | ISO date only |
| Boot animation | `ChatArchViewer.tsx:370-400` | could be skipped + replaced with "WELCOME BACK · last visit Nd ago" | one-shot per browser |
| Empty state | `ChatArchViewer.tsx:1867-1901` | "Your last index ran Nd ago, but no manifest is loaded" — recovery hint | cold-start copy |

**One change** would improve almost all of these: a single shared `LastIndexedChip` component that renders `manifest.generatedAt` relative-formatted (warning color when >30d) — drop it into UpperPanel, DataPanel, Sidebar's DATA pill, and the empty state.

---

## Returning-user default-mode assessment

The default is `mode = 'command'` (SESSIONS) per `ChatArchViewer.tsx:219-229`. The hash-driven branches override only if a deep-link hash is present.

For a 3-months-stale returning user, **SESSIONS is acceptable but not optimal**:

- **Pros**: recent-sort default puts his last session top-left. He can scan and re-anchor by title.
- **Cons**: chrome-heavy (KPI strip is cost-focused, sparkline trails into 3 months of zeros without annotation, FilterBar pills demand interaction). The first thing he sees is a wall of cards and aggregates — not "here's what you were doing".

**Better options**:
- For users with `analysis/projects.json` populated (the v2 happy path): default to `mode = 'projects'`. ProjectsMode is sorted `lastActivityAt desc` so the top row IS the project he last worked on. Single-row scan → re-orientation done.
- A "WELCOME BACK" mini-mode for `manifest.generatedAt < now - 30d`: project rollup + "since last visit" delta + one-click RE-SCAN. This is what the product is missing entirely.

---

## Accidental-destruction risk audit

| Path | Confirm steps | Where | Risk |
|---|---|---|---|
| NuclearReset DELETE … | 2 clicks (armed → commit), checkbox-gated, count shown in CTA, "Are you sure?" copy | `NuclearReset.tsx:187-289` | Low — well-defended. Risk only if Sam misclicks DATA → DELETE… in muscle-memory and is sloppy. |
| `/api/clear` POST | x-requested-with header CSRF gate, requires explicit source list in body | `apps/standalone/src/pages/api/clear.ts` | Low — only the panel calls it. |
| `/api/clear-corrections` POST | (not audited here, presumed similar) | `apps/standalone/src/pages/api/clear-corrections.ts` | Low |
| UNLOAD chip | one click, irreversible (drops uploaded ZIP from IDB) | `UpperPanel.tsx:430-438` | **Moderate** — single click, no confirm. Sam clicking out of curiosity loses his cloud upload. |
| All-cloud wipe via NuclearReset | wipes 3 IDBs (chat-arch, semantic-labels, bench-results) — matches CLAUDE.md spec | `NuclearReset.tsx:244-262` | Low — correctly scoped. |
| All-selected wipe wipes localStorage `chat-arch:*` | `NuclearReset.tsx:267-278` | Loses sortBy, demo banner dismissal, etc. | Acceptable — gated on all-selected. |

**Surprise finding**: the **UNLOAD** chip in the UpperPanel (`UpperPanel.tsx:430-438`) is a single-click destructive action with no confirm. It's labeled `UNLOAD` (not DELETE), which softens the perceived risk, but the consequence is identical: the uploaded ZIP is dropped from IDB and the manifest reverts to disk-only. For Sam exploring chrome out of curiosity, this is more accident-prone than NuclearReset because there's no two-step.

---

## Top 5 Improvements (ranked by returning-user impact)

1. **Surface `manifest.generatedAt` everywhere it matters.** Add a `LastIndexedChip` (relative time, warning at >30d, danger at >90d) to UpperPanel stats row, DataPanel header, and as a Sidebar DATA-pill badge. Single source of truth: `manifest.generatedAt` from `packages/schema/src/unified.ts:300`. **Impact: Sam knows his data is stale within ~3 seconds of landing.** *Files to touch: `UpperPanel.tsx:408-414`, `DataPanel.tsx:183-199`, `Sidebar.tsx:207-232`, plus a new component.*

2. **Add a "WELCOME BACK" banner / soft-modal for stale returners.** When `Date.now() - manifest.generatedAt > 30d` AND `chat-arch:welcome-back-seen-this-session` is unset, render a persistent banner at the top of the viewer: "Your index is 92 days old · 47 unprocessed local sessions · [RE-SCAN]". Reuse the `rescanBanner` slot (`ChatArchViewer.tsx:2013-2032`). **Impact: turns the staleness signal into a one-click recovery.** *Files: `ChatArchViewer.tsx` + a new banner state.*

3. **Make the rescan delta clickable and persistent.** The "12 new local sessions" reward currently auto-dismisses at 6s (`ChatArchViewer.tsx:1686-1690`). Lengthen to 20-30s, and make the message a button that filters SESSIONS to "last 7 days" (or the post-scan delta window) and scrolls to top with a 2s flash on the new rows. **Impact: post-scan moment becomes a re-orientation surface, not a fleeting toast.** *Files: `ChatArchViewer.tsx:1607-1690`.*

4. **Default to PROJECTS mode for returning users with projects.json.** When `mode` is not URL-hash-overridden AND `projects.length > 0` AND `Date.now() - manifest.generatedAt > 7d`, default to `mode='projects'` instead of `'command'`. ProjectsMode's `lastActivityAt desc` sort gives instant re-orientation. Keep SESSIONS default for fresh users. **Impact: the default surface answers "what was I working on" without a click.** *Files: `ChatArchViewer.tsx:219-229`.*

5. **Move DELETE behind a "Danger zone" foldout in DataPanel.** Currently rendered at equal visual weight to UPDATE/UPLOAD (`DataPanel.tsx:334-343`). Risk of muscle-memory misclick is low but non-zero, and the visual prominence implies the action is routine. Collapse it under "Advanced ▸" by default. Also: add typed-confirmation (`type DELETE to confirm`) for the all-everything path only. **Impact: protects curious returners from accidental wipes; doesn't burden routine UPDATE flows.** *Files: `DataPanel.tsx:334-343`, `NuclearReset.tsx:299-403`.*

---

## What works (Sam would appreciate)

1. **Persisted SORT preference** (`ChatArchViewer.tsx:107-116, 246-254`): default `recent`, persisted in localStorage. He left sorted-by-recent; he returns sorted-by-recent. The grid arrangement matches his memory.

2. **Honest delta phrasing on rescan** (`ChatArchViewer.tsx:1630-1643`): "12 new local sessions" / "no new local sessions" / "3 local sessions removed" with the time + total in tow. This is the most thoughtful returning-user touch in the product. The fact that someone wrote a code comment ("delta reads immediately as 'scan was worth doing'", line 1611-1612) suggests this was deliberate.

3. **NuclearReset's two-step confirm + count-in-label** (`NuclearReset.tsx:291-297`): `DELETE SELECTED (847)` → `YES — DELETE 847`. The count travels with the affirmation, so Sam can't accidentally confirm without seeing the consequence.

4. **TopBar SEARCH disabled in detail overlay** (`TopBar.tsx:60, 117-122`, `ChatArchViewer.tsx:2086`). Returning users who drill into a session and start typing aren't silently mutating the underlying list they'll come back to.

5. **`hasLocalData`-aware button labels** (`DataPanel.tsx:123-138, 148-160`): SCAN LOCAL → UPDATE LOCAL, UPLOAD CLOUD → UPDATE CLOUD. This is exactly the right copy adjustment for returners — it telegraphs "you've done this before; this just refreshes". Pity the actual stale-detection isn't equally surfaced.
