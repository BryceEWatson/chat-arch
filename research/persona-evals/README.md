# Persona evaluations

Two jobs live in this directory. They sound similar and are easy to conflate; keeping the distinction explicit avoids future drift.

## Primary user-modeling persona

[`bryce.md`](bryce.md) — the maker-operator. Data-grounded from 160 chat-arch CLI sessions across the project's full lifespan (founding era → present). This is the persona chat-arch is **actually for**. Every product decision should ask "does this serve the workflow in `bryce.md`?"

The 10-row "preserve / automate / get out of the way of" table at the bottom of `bryce.md` is the load-bearing product spec for this persona. It supersedes any conflicting positioning copy elsewhere in `research/` — the refocus-plan and other strategy docs predate the data-grounded persona and should be read in that light.

chat-arch's north star (per `research/refocus-plan.md`) is "personal workshop only — not a team product, not a hosted SaaS." `bryce.md` is the operational answer to "what does the personal workshop's single user look like?"

## Secondary onramp-evaluation personas

[`maya.md`](maya.md), [`david.md`](david.md), [`priya.md`](priya.md), [`sam.md`](sam.md) — hypothetical first-touch users used to pressure-test the hosted-demo onramp at `chat-arch.dev`. These are *evaluation walkthroughs*, not user-modeling docs: each picks a viewpoint (daily power user / cloud-only PM / 90-second drive-by / 3-month-stale returner) and surfaces UI frictions a maker-operator wouldn't see from inside the build.

| Persona | What it pressure-tests |
|---|---|
| [Maya](maya.md) | Daily-use chrome for a returning power user — closest to "someone Bryce would hand the tool to" |
| [David](david.md) | Hosted-demo experience for a cloud-only Claude user |
| [Priya](priya.md) | First-touch from an HN link, 90 seconds before standup |
| [Sam](sam.md) | Returning user with stale local data after a long absence |

These four remain useful *for the demo / first-touch surfaces specifically*. They should NOT be used to:

- Define the product's primary workflow (that's `bryce.md`'s job)
- Justify features that don't serve the maker-operator (the personal workshop is the product)
- Drive prioritization tradeoffs against `bryce.md`-derived work

When a finding from one of the four conflicts with `bryce.md`'s spec, `bryce.md` wins.

## How this resolves the original ambiguity

The first persona-eval pass produced four hypothetical-user walkthroughs without first asking "who is chat-arch fundamentally for?" That's a `bryce.md` question, and answering it after-the-fact reframes the original four as a different (still useful) artifact: onramp evaluations for the hosted demo, not user-modeling docs.

If you arrive at this directory expecting to find personas-of-record for the product, start with `bryce.md`. The others are pressure-test surfaces for a narrower question (does the demo onramp work?), not a wider one (what does the product do?).
