# Hosted chaos harness

The chaos CLI exercises the live Convex deployment at `giant-jellyfish-684` and its Daytona and SpacetimeDB integrations. It invokes hosted Convex functions through `npx convex` from `convex/`; it does not deploy code or change deployment environment variables.

## Prerequisites and safety controls

- Run from the repository root with dependencies installed.
- The process environment must provide `CONVEX_DEPLOY_KEY` and `DAYTONA_API_KEY`. `FACTORY_API_KEY` is required only when starting a real Factory runner (`scale10`, `runner-kill`, or `cancel-mid-run`).
- Convex must have `RUNNER_LAUNCH_MODE=external` and the integration service token configured. The harness refuses capture if external runner mode is not active.
- Do not put credentials or runner callback secrets in source, arguments, result files, or shell history. Convex credentials are read in memory and redacted from reports and errors. `var/chaos/` contains runner logs and probe events; preserve it for diagnosis and treat it as operational data.
- Each live scenario checks global active and retained sandbox reservations plus its required initial slots against capacity five. It waits up to ten minutes for capacity and records the global ForkSafe Daytona sandbox count. The scale scenario reserves only its initial slot so that later runner requests can queue under the capacity limit.
- A previously reported orphaned reservation may reduce available capacity. The harness only counts it; do not repair or modify that reservation as part of a chaos run.
- `duplicate-delivery` and `spacetime-blip` do not start Factory runners. `scale10`, `runner-kill`, and `cancel-mid-run` consume Factory tokens. Do not use `all` casually: it includes all three token-spending scenarios.
- Every scenario attempts cleanup in `finally`. A cleanup result is included in the scenario JSON. If the process is interrupted, run `pnpm chaos cleanup`.

## Commands

```sh
pnpm chaos duplicate-delivery
pnpm chaos spacetime-blip
pnpm chaos scale10 --envs 10 --token-cap 20000 --timeout-min 15
pnpm chaos runner-kill
pnpm chaos cancel-mid-run
pnpm chaos cleanup
pnpm chaos all
```

`--envs` is an integer from 1 to 10 (default 10), `--token-cap` is a positive token budget (default 20,000), and `--timeout-min` is an integer from 1 to 120 (default 15). The CLI creates `var/chaos/chaos-<unix>/`, writes one `<scenario>.json` result per selected scenario, prints a summary table, and exits nonzero if any assertion is failed or not reached. Keep the results and runner logs in place when collecting a report.

## Scenarios and assertions

### `duplicate-delivery` — no Factory spend

Captures one environment, waits for it to become active with a valid credential, then acts as a fixture runner without starting a real runner. It claims a factory-session job, registers an idle fixture session, marks the job started, repeats `write_finding` with one call ID, and replays byte-identical completion requests.

- **D0** records claim/session/start setup.
- **D1** checks duplicate finding response equality, one Convex finding row, and conditionally the SpacetimeDB finding count if the first response says it was shared.
- **D2** checks that one failed completion effect, one attempt, and one non-stale completion acknowledgement were recorded.
- **D3** is a strict replay equality check for the completion response.
- **D4** replays insertion only for the newest existing passed evaluation; it never creates a fixture evaluation.
- **D5** replays completion for that evaluation and checks rejection without changing its job or attempt.

### `spacetime-blip` — no Factory spend

Records **B0** as not reached because the runner does not connect to SpacetimeDB directly: Convex owns the bridge, and BridgeClient's transient 408/429/5xx retries cannot be triggered without redirecting the deployment-wide `SPACETIMEDB_URI` shared by every lane. It then probes the outbox path that is testable without changing deployment configuration.

- **B1** records retry attempts, statuses, errors, retry timestamps, and checks increasing backoff while the outbox item remains pending/dead.
- **B2** repeats the same ingest and checks duplicate receipt identity and one row.
- **B3** scans the full outbox for duplicate idempotency keys.
- **B4** runs two consecutive ingest ticks and checks that the second inserts zero rows.
- **B5** checks that `chaos:blip:` rows have at most eight attempts, eight-attempt rows are dead, and rows older than 25 minutes are dead at eight attempts; it records each row's key, attempts, status, error, and creation time.

Because not-reached checks are non-passing, B0 is reported as a finding and may make the command exit nonzero even when B1–B5 pass.

### `scale10` — Factory spend; do not run until scheduled

Captures the requested number of environments, samples probe-based active turns every second, runs back-to-back Convex snapshots, and lists Daytona sandboxes every five seconds. It starts a runner when an environment first becomes active with an unexpired credential. The default run is 10 environments, 20,000 tokens, and a 15-minute timeout.

- **S1** limits sessions and distinct vendor Factory session IDs to two per environment.
- **S2** limits global active model turns to four and records the maximum model-turn reservations.
- **S3** limits global active/retained sandbox reservations and ForkSafe Daytona sandboxes to five.
- **S4** requires provisioning to queue rather than error, no stall, and every environment to receive a runner sandbox operation and reach active.
- **S5** checks one or fewer turns per session, accepted terminal session states, and records per-session token usage and total tokens.

S1, S2, and S5 are not reached if no runner starts. A stall is 150 seconds with no active environment and no new sandbox operation after entering `searching`.

### `runner-kill` — Factory spend; do not run until scheduled

Starts R1, waits for an open model turn and running job, waits ten seconds, then SIGKILLs R1's process group. It observes lease expiry, starts R2 using the same credential, and replays R1's heartbeat, completion, and `read_findings` requests while attempt two is active.

- **K1** checks the 25–35 second expiry interval and lease bound.
- **K2** checks the reserved retry and pending revocation of attempt one.
- **K3** checks that attempt two has a higher epoch and is active.
- **K4** requires stale requests to be rejected without changing the active job/attempt or creating a non-stale acknowledgement.
- **K5** is the strict HTTP 409 / `stale_epoch` check for all three replays.
- **K6** requires exactly two attempts and one infrastructure retry.

### `cancel-mid-run` — Factory spend; do not run until scheduled

Starts one runner with a 60,000-token cap and waits up to ten minutes for a development experiment, then cancels the investigation and replays completion for the active attempt.

- **C1** checks grant revocation in Convex and SpacetimeDB within 60 seconds.
- **C2** checks sandbox-operation termination and Daytona disappearance within 60 seconds.
- **C3** checks that no candidate was submitted after cancellation.
- **C4** checks rejection of the completion replay and a cancelled (never succeeded) job.
- **C5** checks investigation/cancel status and credential revocation within 90 seconds.

### `cleanup`

Finds nonterminal investigations titled `chaos:*`, cancels and drains their sandbox operations, stops recorded process groups in `var/chaos/*/runners.json`, and reports the global ForkSafe Daytona sandbox count. Cleanup does not change deployment configuration or repair unrelated reservations.
