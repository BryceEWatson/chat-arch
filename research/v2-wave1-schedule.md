# Wave 1 — nightly scan schedule routine

Spec §5 B.1 calls for `pnpm exporter all --no-cloud` to run nightly at
03:00 local. Schedule-skill routines are per-user state (registered via
`CronCreate`), not repo-tracked artifacts, so this file documents the
parameters an operator passes when registering the routine. Re-register
on a fresh machine; only registered once per host.

## Routine parameters

| Field    | Value |
|----------|-------|
| name     | `chat-arch-nightly-scan` |
| cron     | `0 3 * * *` (03:00 local) |
| command  | `pnpm --filter @chat-arch/exporter start all --no-cloud` |
| cwd      | repo root (`c:\Users\Bryce\Projects\chat-arch` on the dev machine) |
| recurring| `true` |

## Why `--no-cloud`

Cloud scan depends on a user-initiated Privacy-export ZIP upload. There
is no automatic re-fetch path; running the cloud phase nightly would
just re-read the same stale ZIP. `--no-cloud` preserves whatever cloud
data the last manual upload produced and only refreshes the local
sources (Cowork, host-CLI, WSL-CLI).

## What the routine writes

After each run, `analysis/continuum-health.json` is rewritten with an
incremented `consecutiveSuccesses` (on success) or zeroed (on failure).
The viewer footer + the daily brief read from this sidecar.

## Companion brief routine (Wave 3)

The Wave 3 daily-brief generator (spec §5 D.2) will register a second
routine at `0 4 * * *` that runs 60 minutes after this scan and produces
the daily markdown brief. Defer until Wave 3 lands — there is no brief
generator to invoke yet.
