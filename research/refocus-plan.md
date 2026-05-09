# chat-arch refocus plan

Source: persona evaluations in `research/persona-evals/{maya,david,priya,sam}.md`.

## North star

> **Find the rules Claude keeps breaking. Patch your CLAUDE.md / skills.
> Prove the loop closed.**

The unique pitch is the closed-loop self-improvement workshop. Browsing
and analytics are commodity; the workshop is the moat. Every UI surface,
copy choice, and feature decision must serve this loop or be demoted.

## What "refocus" requires (3 levers)

| Lever | What it controls | Failure mode if skipped |
|---|---|---|
| **Visual hierarchy** | What is loud vs. quiet — sidebar order, default mode, empty-state copy, headlines | Loop is buried; users find the dashboard, not the workshop |
| **Feature gating** | What is available vs. hidden — hosted vs. local, modes behind disclosure, CTA visibility | David's hosted dead-ends; Maya's loop never closes |
| **Code mass** | What stays in the repo vs. gets deleted | Maintenance budget bleeds into modes that don't earn it; quality of the loop suffers |

A visual-only refocus is reversible noise. A gating-only refocus leaves
dead code rotting. Both are half-measures. Real refocus hits all three.

## Phasing

### Phase 0 — Commit (this PR)
- This document.
- Update `README.md` opening to lead with the workshop pitch (not "personal archive").
- Update empty-state `ErrorState` detail to state what the product does in one line above the action buttons.

### Phase 1 — Close the loop (load-bearing)
Validates the framing. Maya is the user.
- New `POST /api/apply-correction` endpoint writing `appliedAt` (schema already supports it at `packages/schema/src/correction.ts`).
- Wire APPLY button at `CorrectionPatternCard.tsx:246-254`.
- Make correction instances clickable → source session (mirror `PracticeMode.tsx:140-146`).
- New `applied-improvements.json` ledger: timestamped patches + the rule they patched.
- Persistent rescan delta (drop the 6s toast at `ChatArchViewer.tsx:1686-1690`; pin into ActivityLogPanel).

### Phase 2 — Refocus the UI
- Sidebar restructure: **WORKSHOP** (Corrections, Practice, Skill seeds, Applied) | **BROWSE** (Sessions, Detail, Search) | **ANALYTICS** (collapsed disclosure: Projects, Topics, Sparkline).
- Default mode for returning users with `appliedAt` history: a new **Workshop / "Since you patched"** surface — N new violations of patched rules, M new clusters since last patch, freshness chip with `manifest.generatedAt`.
- Default mode for first-time users with data: Sessions list with a single "RUN MINING" CTA banner.
- Pin `LastIndexedChip` (manifest.generatedAt) in the TopBar — replaces or sits next to EARTHDATE.
- TrustStrip stays footer-pinned post-load (David's complaint).

### Phase 3 — Gate or cut misaligned modes

| Mode | Decision | Rationale |
|---|---|---|
| ConstellationMode | **Cut** | Visualization without a clear job-to-be-done; doesn't feed the loop |
| TopicsMode | **Defer behind opt-in disclosure** | 36MB embed download is expensive; topics are commodity insight; not load-bearing for workshop |
| CostMode | **Cut** (or defer to ANALYTICS disclosure) | Cost is interesting but doesn't drive a patch decision |
| CommandMode | **Defer behind ANALYTICS disclosure** | Useful for power users but not the headline |
| TimelineMode | **Keep** but demote to ANALYTICS group | Sparkline overlaps; one of them becomes the canonical timeline |
| ProjectsMode | **Keep** in BROWSE — useful re-orientation | Sam's path; cheap to keep |
| PracticeMode | **Promote to WORKSHOP group** | Already has the clickthrough pattern Maya needs |
| DetailMode | **Keep** — table stakes | – |

Cutting means deleting the source files + tests, not hiding behind a
flag. Hiding behind flags is how code mass accumulates. If we're wrong,
git history brings them back in one revert.

### Phase 4 — Hosted = demo + sales

- chat-arch.dev becomes a sales site: hero pitch + live demo (LOAD DEMO DATA pre-loaded) + install instructions + GitHub link.
- No CHOOSE ZIP on the hosted build. Cloud-only users are not the target customer for the workshop pitch — the loop requires patching CLAUDE.md, which assumes local Claude Code use.
- All four CLI-only CTAs David flagged disappear because hosted no longer pretends to be a full product.
- Self-host is the actual product surface; hosted is the storefront.

### Phase 5 — High-leverage additions
- **Weekly digest** — "Sunday review: 3 patterns to patch this week."
- **Applied-improvements timeline** — patch ledger with rule-broken-since-applied counts. The ROI artifact.
- **Diff-against-yourself** — "Your tool-use changed since you patched X 6 weeks ago."

## Decisions to confirm before Phase 3

These are real cuts. None of them is reversible without revert work.

- [ ] **Cut ConstellationMode entirely**
- [ ] **Defer TopicsMode behind opt-in disclosure** (don't cut — costly to rebuild)
- [ ] **Cut CostMode entirely**
- [ ] **Defer CommandMode behind ANALYTICS disclosure**
- [ ] **Drop CHOOSE ZIP from hosted build**
- [ ] **Promote PracticeMode + Corrections to top-level WORKSHOP group**
- [ ] **Make APPLY + clickthrough P0 (this sprint)**

## Anti-goals (what we are explicitly NOT building)

- A general AI conversation dashboard (David's product). Anthropic + others will out-feature us on this.
- A topic-clustering analytics tool. The 36MB embed cost only pays off for the workshop loop, not as a standalone feature.
- A team / org / multi-user product. Personal workshop only.
- A hosted SaaS. Self-host is the product; hosted is the storefront.

## Success metric

For Maya, in one sentence: *"I came back today, ran UPDATE LOCAL, saw 3
new violations of rules I patched last month, hit APPLY on a new
correction, and re-scanned to verify the loop closed."* If a session
that doesn't end this way is the failure mode.
