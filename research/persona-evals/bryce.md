# Persona evaluation — Bryce, the maker-operator

Bryce is the author of chat-arch and its heaviest single user. Where Maya / David / Priya / Sam are *user-under-audit* personas (each "what would this user see and miss?"), Bryce is a *maker-operator* persona: he both ships the product and dogfoods it daily, often in the same session. This profile is data-grounded — mined from 160 of his Claude Code CLI sessions across the chat-arch project's full ~5-month lifespan (founding era through PR #105 on 2026-05-25). Each pattern below cites verbatim prompts with `[SID:<session-prefix>]` anchors.

The intent of this doc is not the same as the others': it is not "what does Bryce see when he opens chat-arch?" — he wrote every surface; he already knows. It is "what does Bryce's actual usage say about how he wants the product to work, and which behaviors should chat-arch preserve, automate, or get out of the way of?"

---

## 1. Specification-as-prompt

**Pattern.** Bryce does not converse with Claude; he writes mini-RFCs. Every load-bearing prompt has a scope block, an explicit DO-NOT list, a deliverable definition, and references to file:line evidence. Casual exploratory prompts are rare — even discovery passes are framed as "read-mostly research → single written recommendation."

**Evidence.**

- [SID:c9a0169b] "DO NOT make any code changes" + "Read-only investigation followed by a single written recommendation" — discovery passes are explicit gates, not open-ended chats.
- [SID:8f66baa2] "Read-mostly; commit changes only if I ask you to act on the plan in a follow-up message."
- [SID:bcddb358] "Use AskUserQuestion for the open decisions above BEFORE coding" — planning decisions are user-facing gates, not Claude decisions.
- [SID:session-30, founding era] A 1,288-line E2E test implementation spec with defensive coding requirements ("avoid accidentally arming in a packaged build"), tier-1/tier-2/tier-3 scoping, and explicit permission to ship incomplete: "A useful 80%-fill PR is far better than a stalled 100%-fill PR."
- [SID:00944d87, this session] "Bundle BOTH fixes into ONE PR. Project convention is small-focused PRs for human-paced work, but Claude-Code-paced bundling is allowed when two fixes share a release."

**What this implies for chat-arch.** The product should make it easy to capture "the prompt that worked" as a reusable artifact. The PRACTICE surface and the `playbook-candidates` pipeline are early gestures in this direction; the natural next step is a "rerun this prompt" or "save this prompt as a skill argument" affordance on session-detail pages. The save-prompt API already exists (`/api/save-prompt`) but the prompt-mining + lift-into-skill pipeline isn't wired through the UI yet.

---

## 2. /loop as control primitive, validation as gate

**Pattern.** `/loop` is his default iteration mechanism — not a slash command he occasionally remembers, but the way he expects sustained work to happen. Loops always run through a validation gate (adversarial review team, falsifier, lint/test/build) before he accepts a step as done.

**Evidence.**

- [SID:fed44166] "Run adversarial review teams against all of the PRs, then /loop until no verified issues are being found and the PRs are all merged."
- [SID:24986e2f] "Merge it now and continue. Loop until all validated issues are resolved, like before."
- [SID:eaadc510] "Did you forget to validate and confirm the adversarial results again? These situations are exactly the ones I want to see get flagged by the system."
- [SID:b1f24301] "Take a look at the PR review comments, then spin up an adversarial review team to fully review the PR. Confirm findings before fixing them."
- [SID:761dffb1] "Continue, don't wait."

**What this implies for chat-arch.** Bryce trusts a fix only after a falsifier or adversarial review has tried to disprove it. The `/review-loop` global Stop hook, the curator/falsifier kernels, and the `falsifier-verdicts.json` sidecar all encode this discipline — but chat-arch doesn't yet measure *how often validated findings catch issues that would otherwise have shipped*. A "validation ROI" surface (fixes caught by adversarial pass / total fixes) would close the loop on this loop.

---

## 3. Start-of-turn state reconciliation

**Pattern.** Every multi-step session opens with branch / PR / stash audit. He doesn't act on yesterday's context; he reconciles current world state first, then proceeds. This is durable enough that it's a feedback memory.

**Evidence.**

- [SID:023e5e2b] "self-pacing each iteration ... fetch origin, check PRs"
- [SID:c9a0169b] Lengthy reconciliation prompt: "5 open PRs, an active feature branch with uncommitted dirty work, a stash on top of that"
- [SID:bcddb358] "State reconciled: on feature/blog-draft-generation"
- [SID:c9a0169b] "don't lose my in-progress work. The dirty state on feature/outcome-substrate-roadmap includes a real refactor ... that already addresses one security finding."

**What this implies for chat-arch.** The product itself has no state-reconciliation surface — there is no "where am I right now in this corpus?" view that orients him at session start the way `git status` does in a repo. The closest existing equivalent is the TODAY page's daily brief, which is *backward-looking*. A "current state of the workshop" snapshot (open PRs the corrections pipeline touched, the last 3 narratives whose status changed, the curator feed delta since last visit) would mirror in-product what he already does in-repo.

---

## 4. First-principles reset when uncertain

**Pattern.** When a UI direction feels off or a plan looks tangled, he restarts from axioms rather than patching forward. Often coupled with "look through our chats to ensure we're still aligned with the original goals."

**Evidence.**

- [SID:fed44166] "I want to go back to first principles on the UI design of all of this, considering our recent work."
- [SID:acdae515] "Let's go back to first principles with everything we've discussed and create a new plan."
- [SID:acdae515] "What if we thought of all of this as an ecosystem of tools, skills, agents, that work collaboratively to build towards our highest tier of analysis?"
- [SID:f377b754] "Can you look through our chats to ensure we're fulfilling our original goals?"
- [SID:b964680a] "I want you to look through our recent conversations to understand the direction we've been moving."

**What this implies for chat-arch.** He uses his own chat history as a planning artifact — externalizing direction-of-work into the corpus rather than re-loading it from his head. The `/chat-answer` skill and the chat-history-search workflow are designed for exactly this. A "north-star drift detector" — flagging when current work's vocabulary diverges from the original spec's — would automate a check he does manually every few weeks.

---

## 5. Multi-session handoff via prompt-as-context

**Pattern.** Most non-trivial sessions end with "give me a prompt that will continue this work in a new session, with all needed context." He treats prompts as the durable artifact, not session UUIDs. The persona itself was requested this way in this session: "create my persona as well" with full context expected to live in the next prompt.

**Evidence.**

- [SID:023e5e2b] "Provide me with a prompt that will continue this work in a new session. Provide all needed context in the prompt."
- [SID:acdae515] "Provide me with a prompt that will kick off a new session that will loop until the plan is fully, verifiably, implemented tested and reviewed."
- [SID:86ec4c60] "Validate visually that it is all working to spec, iterate until it is, then provide me with a prompt to start the next session."

**What this implies for chat-arch.** The save-prompt endpoint exists; surface integration with session-detail does not. A "next session prompt" affordance that auto-drafts a continuation prompt from the trailing N turns of the current session would short-circuit the manual handoff step he runs at the end of nearly every loop.

---

## 6. Anti-hallucination protocols, scoped by task type

**Pattern.** He has *learned* which tasks Claude hallucinates on (content / narrative work) versus which it doesn't (code review with file:line citations). He activates an explicit anti-hallucination protocol for the former and trusts the inherent gates of the latter.

**Evidence.**

- [SID:session-29, founding era] Activates "ANTI-HALLUCINATION PROTOCOL" for blog post QA
- [SID:session-31, founding era] Same protocol re-activated for a second content-review pass
- [SID:session-38, founding era] On code work: "Re-verify each citation before changing code — if the codebase has moved, the cited fix location may have moved too. Verify by reading current code, NOT by trusting this prompt's line numbers blindly."

**What this implies for chat-arch.** The corrections-mining pipeline already classifies pushbacks; classifying them by *task type* (content vs code vs planning) would surface which task-types he most often has to redirect on — and the playbook surface could light up exactly the right anti-hallucination preamble per task type.

---

## 7. Validation against his own automation

**Pattern.** Even when running tools he wrote himself, he treats output as a hypothesis to validate. The auto-brief, the surprises kernel, the curator feed — none of these get a free pass. Every claim is verifiable, and he checks.

**Evidence.**

- [SID:fed44166] "I just ran a scan, can you make sure it went through properly?"
- [SID:acdae515] "I don't want to take it as truth, but to look to see what we can learn and improve on as well."
- [SID:acdae515] "It also skipped many chats because they were too big. How are we handling this?"
- [SID:00944d87, this session] "addressed ≠ delivered. Verify both bugs end-to-end after the fix, not just compile-clean."

**What this implies for chat-arch.** Every kernel output should carry a *how-to-falsify-this* affordance — a "show me the evidence" drill-in that already exists for surprises and trajectories but is missing on the brief. The brief currently presents counts and ranked lists; it doesn't link to a "what would change my mind?" view.

---

## 8. Dogfooding as primary feature-discovery loop

**Pattern.** Most chat-arch features begin life as a friction Bryce hits in his own usage, gets analyzed in a chat-arch session, surfaces as a correction or pattern, and ships as a feature. The product's roadmap and his daily friction log are the same artifact.

**Evidence.**

- [SID:eaadc510] "I think what we're landing on is a correction mining view for chat-arch."
- [SID:b964680a] "Look through our recent conversations to understand the direction we've been moving."
- [SID:acdae510] "What if we had a stronger focus on self improvement, both of the user and the system?"
- This very PR (Bug 1 + Bug 2 → PR #105) followed the loop: friction observed in scan run → bug-pair filed as one task → fix shipped.

**What this implies for chat-arch.** This is the product's strongest competitive moat: a daily-use feedback loop most projects don't have. The corrections-pipeline + applied-watcher + outcome-substrate are deliberate machinery for this loop. But the *time-to-feature* metric (friction filed → fix shipped) isn't measured anywhere. Surfacing it would let him optimize the loop directly.

---

## 9. Voice — terse status checks, elaborate context blocks

**Pattern.** Two distinct prompt shapes. Short status pings during tight iteration ("What's the status?", "Continue, don't wait", "Merge it now"). Elaborate 800-1500-word context blocks at task boundaries (handoff specs, founding-era E2E specs, this session's Bug 1 + Bug 2 brief). No middle register.

**Evidence.**

- Short: [SID:761dffb1] "What's the status?" · [SID:fed44166] "fix all issues first, yes" · [SID:24986e2f] "Merge it now and continue."
- Long: [SID:00944d87] this session's 1,200-word task block with Symptom / Root cause / Fix / Diagnostic steps sections per bug. [SID:bcddb358] 800-word task definition with read-first / constraints / DO-NOT / deliverables.

**Other voice signals.**

- "I want" + "I don't like" — direct preference, no hedging ([SID:bcddb358], [SID:f377b754]).
- "Shouldn't that happen automatically?" — challenges the existence of manual steps ([SID:b1f24301]).
- "I hope none of this is hard coded" — skeptical of magic numbers + brittle heuristics ([SID:b1f24301]).
- "Drill down to see all of the evidence" — wants depth-on-demand, not pre-summarized verdicts ([SID:fed44166]).

**What this implies for chat-arch.** UI cards in the FEED already implement drill-down-to-evidence (the surprise cards' "→ in context" links). Extending this discipline to the brief sections (every count is clickable into its evidence) would match his evidence-maximalist preference without changing the brief's terseness.

---

## 10. Recurring friction surfaces

The frictions below appear across multiple sessions and are stable enough to ship around.

- **Branch / PR / stash state complexity.** Multiple sessions juggling 3-4 open PRs simultaneously; explicit "don't lose my in-progress work" instructions ([SID:c9a0169b]). Already addressed in the `feedback_state_reconciliation` memory; the product itself has no equivalent surface.
- **Stale dev server / port collision.** [SID:fed44166] "ports 4321-4334 in use ... leftover dev servers" — happened again *in this very session* (11 ports held by various Astro instances). A "stop all chat-arch dev servers" affordance would be small but high-leverage.
- **Local PII overrides conflicting with staging discipline.** The `manifest.json` belongs-to-disk-but-not-to-git rule had to be encoded as a hook + a CLAUDE.md memory after it bit once. Still appears as a recurring source of `git status` noise.
- **Async UI feedback lag.** [SID:9630c445] "wish UI would be responsive instead of saying this" — during long-running endpoint calls, the page status line goes silent. The recent `[SCAN] step N/M failed` console.warn instrumentation is a partial mitigation; structured client-side progress events are the durable fix.
- **Over-automation distrust.** [SID:8f66baa2] "What can we do to ensure you never take shortcuts like these again? Take a deeper look at root causes, then review this entire development session to see if we took any major wrong turns." When Claude skips a validation step, he doesn't just redirect — he asks for a process-level audit.

---

## Coverage notes

- **Files scanned:** 160 chat-arch CLI sessions out of 627 total (4 buckets × 40 sessions, sampled by `mtime` recency: founding-era → recent).
- **Source corpus:** `~/.claude/projects/C--Users-Bryce-Projects-chat-arch/*.jsonl`. Cowork sessions not mined for this pass — Bryce uses Cowork primarily for browser-mode tasks (cloud dashboards / signup flows / domain setup per `user_tooling` memory), not for chat-arch development work.
- **False positives filtered:** `tool_use_id` / `tool_result` content, `<task-notification>` wrappers, TodoWrite items, `isSidechain` / `isApiErrorMessage` lines, `<system-reminder>` / `<command-message>` injections.
- **Confidence:** High across all 10 patterns. Every pattern appears in at least 2 time buckets (founding + recent OR mid + recent), confirming durability rather than phase-specific drift.
- **What this persona does NOT cover:** Cowork browser-mode usage; cross-project patterns (his other repos: brycewatson.com, ShopForge, ShopSmith-v2, etc.); off-hours work rhythm (timestamps not parsed in this pass).
- **Re-mine cadence:** This persona should be refreshed quarterly. The mid-era → recent comparison already shows the `/curate` + `/falsify` skills moving from "newly introduced" to "routine"; expect new tooling patterns to surface over the next quarter that aren't here yet.

---

## What chat-arch should preserve, automate, or get out of the way of

A one-screen TL;DR for product decisions:

| Behavior | Action |
|---|---|
| Specification-as-prompt | **Preserve.** Save-prompt + skill-argument lift is the natural ramp; don't replace with chat-style. |
| /loop + validation gates | **Automate harder.** Measure validation ROI; surface it on PRACTICE. |
| Start-of-turn reconciliation | **Mirror in product.** "Current state of the workshop" view, like `git status` for the corpus. |
| First-principles reset | **Detect drift.** Compare current-work vocabulary to founding-era spec; surface divergence. |
| Multi-session handoff | **Affordance.** Auto-draft "next session prompt" from trailing turns. |
| Anti-hallucination protocols | **Classify by task type.** Per-task playbook preambles. |
| Validate his own automation | **How-to-falsify on every kernel output.** Brief sections need drill-ins. |
| Dogfooding feedback loop | **Measure time-to-feature.** Friction-filed → fix-shipped metric. |
| Drill-down to evidence | **Extend to brief.** Every count clickable into its evidence. |
| Dev server port chaos | **One-button "stop all chat-arch dev servers."** |
