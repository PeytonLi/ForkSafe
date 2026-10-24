# Implementation status

Last updated: 2026-10-24 (UTC), on `main` at `c0dc558`.

ForkSafe has run two real investigations end to end on the hosted stack: a real
baseline in Daytona, Factory agents in two environments, shared evidence in
SpacetimeDB, signed protected evaluations, a Jira issue, and (for one run) an
approved human review bound to the controller SHA. Details and IDs are in the
[integration matrix](docs/integration-matrix.md).

## What is done (merged into `main`)

| Area | Status | Where | PRs |
| --- | --- | --- | --- |
| Shared contracts (zod schemas, enums) | done | `packages/contracts` | round 1 |
| Simulator and protected evaluator (MuJoCo Panda, signed manifests) | done | `services/simulator`, `services/evaluator`, `evaluation/` | #12, #13 |
| Convex lifecycle, jobs, leasing, fencing, outbox, reconcile | done | `convex/` | #19, #21 |
| Daytona adapter and snapshots | done | `packages/integrations/daytona` | #19, #22 |
| Trusted runner and Factory agents (five tools) | done | `apps/runner`, `packages/agents` | #19, #21 |
| SpacetimeDB module (grants, evidence, findings, `finding_use`, revisions) | done, on Maincloud | `packages/spacetimedb` | round 1, #16 |
| Elastic indexer, search, Agent Builder | done | `packages/integrations/elastic`, `convex/dispatchers/elastic.ts` | #11, #15 |
| Jira, Confluence adapters and Forge app | done, Forge FIT path untested | `packages/integrations/atlassian`, `apps/forge`, `convex/forge.ts` | #11, #18, #20 |
| Web app (replay, environments, evidence, compare, review) | done, hosted | `apps/web` | round 1, #14, #20 |
| Health page, "Why did this fail?", ghost replay, timeline, influence graph | merged, partly deployed | `apps/web`, `convex/web/*` | #23 |
| Ops: doctor, hosted smoke, sandbox cleanup, release check, runbook | done | `scripts/`, `docs/operations` | #9, #17 |
| Evidence pack | done | `packages/evidence-pack` | #10 |

## Integration modes

| Integration | Mode |
| --- | --- |
| Convex | live |
| SpacetimeDB Maincloud | live |
| Daytona | live (cannot reach Factory or Maincloud from inside a sandbox) |
| Runner | live on an external host |
| Factory Droid | live in runs; readiness doesn't probe it |
| Protected evaluator | live in runs; readiness label still says not implemented |
| Elastic | live, retrieval only |
| Kibana Agent Builder | configured |
| Jira | live, review projection |
| Forge | configured (needs a real FIT token test) |
| Confluence | configured |
| Telemetry | not implemented on main (PR #24) |
| Chaos harness | not implemented on main (PR #25) |

## Pending (not done)

- **PR #24**, OpenTelemetry tracing and metrics for runner and evaluator: open.
- **PR #25**, `pnpm chaos` harness and findings: open.
- Deploying the rest of the #23 Convex functions (`web/ask`, `web/timeline`) to
  the hosted deployment. Only `web/health:pipeline` is there now.

## Known limits

- Daytona on this org's tier blocks `api.factory.ai`, `app.factory.ai` and
  `maincloud.spacetimedb.com`, so the runner runs outside Daytona (#22).
- A real Forge Invocation Token has not been tested, so reviewing from inside
  Jira is not verified.
- One withheld evaluation in run `fbdc8b1c...` didn't reach SpacetimeDB
  (Maincloud HTTP 530).
- Jira issue status does not follow the ForkSafe state (FS-3 is still To Do
  although its run was approved).
- `KIBANA_API_KEY` isn't set on the hosted deployment.
- Reading `convex/investigations.ts`: an investigation created with
  `autoStart: false` reaches `admitted` after capture, but the public `start`
  mutation only starts from `capturing` and returns `duplicate: true` for
  `admitted`. Worth a look by the pipeline lane.

See [verification report](docs/verification-report.md) for the latest test run.
