# Hackathon log

- **Project:** ForkSafe
- **Event:** Cal Hacks 13.0
- **What it does:** Turns a plain-words robot failure description, or an imported failure recording, into a proven controller repair, run by parallel agents and graded on hidden test cases.
- **Live app:** https://giant-jellyfish-684.convex.site
- **Repo:** https://github.com/PeytonLi/ForkSafe
- **Frontend:** Convex static hosting
- **Convex deployment:** https://giant-jellyfish-684.convex.cloud
- **Components:** @convex-dev/static-hosting, @convex-dev/workflow, @convex-dev/workpool (two pools: daytonaPool, outboxPool) — convex/convex.config.ts
- **Convex features:** schema (41 tables), indexes, queries, mutations, actions, HTTP actions (7 routes in convex/http.ts), crons (4 intervals in convex/crons.ts), scheduled functions, realtime useQuery
- **Auth:** Convex Auth (Google sign-in via Auth0 in the web app)
- **AI models:** gpt-4o-mini (convex/describe.ts scene matching); Factory agent model comes from env, no fixed id in code
- **Started:** 2026-10-24T09:06:51Z
- **Last updated:** 2026-10-25T20:09:09Z

## How we use Convex

- The whole investigation lifecycle — capture, job admission, agent environments, evaluation, review — lives in Convex tables and workflows (convex/schema.ts, convex/workflows.ts). Every investigation screen updates live via useQuery; nothing needs a refresh.
- Live simulation streaming: sandboxed sims push frames to Convex HTTP actions and the viewer replays them live (convex/web/live.ts, live-stream-sweep cron).
- Job dispatch with leases and budgets: the runner pool polls jobs through HTTP actions and expired claims get reclaimed by the reconcile cron (convex/crons.ts, convex/reconcile.ts).
- The outbox: delivery to SpacetimeDB, Elastic, and Jira goes through a durable outbox table with retries and dead-lettering, driven by the outbox-ingest cron and outboxPool workpool (convex/outbox.ts).
- Durable orchestration uses @convex-dev/workflow plus two workpools — one paces Daytona sandbox operations, one paces outbound delivery (convex/convex.config.ts).

## Log

- 2026-10-24 7284e5e — handoff docs and implementation status (docs/)
- 2026-10-24 2cf3a19 — monorepo scaffold, contracts, env config, doctor
- 2026-10-24 ed2e26d — Factory agent adapter (packages/agents)
- 2026-10-24 87021f3 — trusted runner service (apps/runner)
- 2026-10-24 958fc8c — web investigation workspace (apps/web)
- 2026-10-24 82b7166 — MuJoCo simulator and controllers (services/simulator)
- 2026-10-24 8bb1d80 — locked evaluation suites and evaluator (services/evaluator)
- 2026-10-24 96fb2f0 — SpacetimeDB lane (packages/spacetimedb)
- 2026-10-24 c8606d9 — workflow orchestration backend (convex/)
- 2026-10-24 a09cda6 — Daytona and artifact adapters (packages/integrations)
- 2026-10-24 762a3d8 — Atlassian integration and Forge app (apps/forge)
- 2026-10-24 75247a0 — Describe-it scene matching (convex/describe.ts)
- 2026-10-24 13eea14 — scene overrides, scenario editor, New simulation
- 2026-10-24 6ed6671 — simulation loop, varied extra environments
- 2026-10-25 657ba8f — environment tabs and wide card layout (apps/web)
- 2026-10-25 bb5b8a9 — cross-run citation and submit-chain fix (apps/runner, convex)
- 2026-10-25 1b82896 — auto-start on forksafe-labeled Jira issue (apps/forge)
- 2026-10-25 a955104 — operator sweep for dead outbox rows (convex/outbox.ts)
