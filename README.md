# ForkSafe

ForkSafe helps you find out **why a robot controller failed, and prove that a
fix really works**.

You start with one recorded failure: a Franka Panda arm that clips a divider
while placing a block. ForkSafe then:

1. **Replays the failure** in real MuJoCo physics so everyone sees the same thing.
2. **Starts several independent agent environments.** Each one gets its own
   sandbox and its own AI agent (Factory Droid) that runs experiments and
   proposes a fixed controller.
3. **Shares evidence in SpacetimeDB.** Every experiment, finding and candidate
   lands in one shared database, so environments can learn from each other and
   you can trace which finding led to which fix.
4. **Runs a protected evaluation.** Each candidate is tested in a fresh sandbox
   on public cases and on withheld cases the agents never see. The evaluator
   signs its results, and nothing unsigned is scored.
5. **Asks a human to review.** The approval is tied to the exact controller
   file (its SHA-256), so nobody can swap the code after it was approved.

**Hosted app:** https://giant-jellyfish-684.convex.site
Signed-out visitors see a short list of public investigations. Sign in with
Google, then ask Peyton for an invite code to start or review runs. An existing
email account can still sign in with its password.

> **Honest labels.** Fixture mode shows a recorded story, not live physics.
> `pnpm benchmark` runs real physics on your machine. The hosted health page
> only checks that cloud services answer. A full hosted repair is a separate
> thing again. See [what is live](docs/integration-matrix.md).

## 10-minute quickstart (no keys needed)

You need Node 22, pnpm 10, [uv](https://docs.astral.sh/uv/) and Python 3.12.

```bash
git clone https://github.com/PeytonLi/ForkSafe.git && cd ForkSafe
pnpm run setup          # Node + Python deps, robot assets, creates .env.local
VITE_FORKSAFE_DATA=fixture pnpm dev
```

Open http://localhost:5173. The banner says this is **recorded fixture data**.
Click through the baseline replay, the environments, the evidence and the
review screen. Reviews you submit here stay in your browser.

Want real physics too? In a second terminal:

```bash
pnpm benchmark          # real MuJoCo run of the original controller, about 20 seconds
```

Use `pnpm run setup` and `pnpm run doctor` (with `run`): plain `pnpm setup` is a
pnpm built-in. If something goes wrong, see [troubleshooting](docs/troubleshooting.md).

## Full cloud setup

Copy `.env.example` to `.env.local` (setup already did) and fill in what you
need. Never commit real values. `pnpm run doctor` tells you which names are
missing, and `pnpm run doctor --live` checks each service with a read-only call.

| Variable | What it is | Where to get it |
| --- | --- | --- |
| `APP_MODE` | `local` or `cloud` | Pick one; `local` is the default |
| `WEB_PORT` | Port for the web app | Defaults to 5173 |
| `CONVEX_MODE` | `local` or `cloud` | Pick one |
| `CONVEX_URL`, `VITE_CONVEX_URL` | Convex API URL (`https://<name>.convex.cloud`). Setting `VITE_CONVEX_URL` makes the web app use live data | Convex dashboard, deployment settings |
| `CONVEX_SITE_URL` | Convex HTTP URL (`https://<name>.convex.site`) | Convex dashboard, deployment settings |
| `CONVEX_DEPLOY_KEY` | Lets the CLI deploy and run functions | Convex dashboard, Settings, Deploy keys |
| `CONVEX_ADMIN_KEY` | Admin key for readiness checks | Convex dashboard (optional) |
| `DAYTONA_MODE` | `local` or `cloud` | Pick one |
| `DAYTONA_API_KEY` | Creates sandboxes | Daytona dashboard, API Keys |
| `DAYTONA_API_URL` | Daytona API endpoint | Keep `https://app.daytona.io/api` |
| `DAYTONA_RUNNER_SNAPSHOT`, `DAYTONA_EXECUTION_SNAPSHOT` | Sandbox images for runner and physics/evaluator | Printed by `pnpm daytona:prepare` |
| `DAYTONA_MAX_ACTIVE_SANDBOXES`, `DAYTONA_EXECUTION_CONCURRENCY` | Sandbox caps | The org cap is 5; keep the defaults |
| `RUNNER_MODE` | `local` or `cloud` runner | Pick one |
| `ARTIFACT_MODE`, `ARTIFACT_ROOT` | Where replays and logs are stored | `local` and `./var/artifacts` work out of the box |
| `RUNNER_CALLBACK_SECRET`, `INTEGRATION_SHARED_SECRET` | Shared secrets between services | Make your own: `openssl rand -hex 32` |
| `SIMULATOR_MODE`, `SIMULATOR_URL`, `EVALUATOR_URL` | Local physics and evaluator services | Defaults are `http://127.0.0.1:8000` and `:8001` |
| `EVALUATOR_SERVICE_TOKEN` | Token for the evaluator service | Make your own: `openssl rand -hex 32` |
| `SPACETIMEDB_MODE`, `SPACETIMEDB_URI`, `SPACETIMEDB_DATABASE` | Shared evidence database | `wss://maincloud.spacetimedb.com` and `forksafe`; see [publishing](docs/publish-spacetimedb.md) |
| `FACTORY_MODE`, `FACTORY_API_KEY`, `FACTORY_MODEL` | The AI agent | Factory app, Settings, API keys |
| `ELASTIC_MODE`, `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY` | Search index | Elastic Cloud deployment page and Kibana, Stack Management, API keys |
| `ELASTIC_AGENT_BUILDER_MODE`, `KIBANA_URL`, `KIBANA_API_KEY` | "Why did this fail?" answers | Kibana URL from the deployment page; the ES API key also works for Kibana |
| `ATLASSIAN_MODE`, `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`, `ATLASSIAN_PROJECT_KEY` | Jira review issues | Your site URL, your login email, a token from id.atlassian.com, Security, API tokens; project key `FS` |
| `FORGE_APP_ID` | Jira review panel app | `apps/forge/manifest.yml`, or `forge register` for your own copy |
| `MAX_ENVIRONMENTS`, `DEFAULT_ENVIRONMENTS`, `MAX_ACTIVE_MODEL_CALLS` | Run size limits | Keep the defaults |

The hosted Convex deployment also needs some variables that live only in Convex
(set with `npx convex env set`): `FORKSAFE_BRIDGE_SECRET` (must match the
SpacetimeDB module), `FORKSAFE_EVAL_SIGNING_KEY` and `FORKSAFE_EVAL_TRUSTED_KEYS`
(evaluator signing), `RUNNER_LAUNCH_MODE=external` (see below),
`FORKSAFE_INVITE_CODE`, `FORKSAFE_PUBLIC_INVESTIGATION_IDS`, `FORKSAFE_WEB_URL`,
`FORGE_ALLOWED_INSTALLATION_IDS`, the Convex Auth keys `JWT_PRIVATE_KEY`,
`JWKS`, `SITE_URL`, and the Auth0 application `AUTH_AUTH0_ISSUER`,
`AUTH_AUTH0_ID`, `AUTH_AUTH0_SECRET`. Auth0 holds the Google connection.
See [Convex](docs/integrations/convex.md),
[web access](docs/web-access-control.md) and the
[on-call runbook](docs/operations/runbook.md).

**One important network limit.** Daytona sandboxes on this org's tier cannot
reach Factory or SpacetimeDB Maincloud. So the trusted runner runs on an
outside host (`RUNNER_LAUNCH_MODE=external`), while Daytona still runs the
physics and the protected evaluator. Details: [Daytona network](docs/integrations/daytona-network.md).

## Commands

Every command below is a script in `package.json`.

| Command | What it does | Needs keys? |
| --- | --- | --- |
| `pnpm run setup` | Install Node and Python deps, fetch and verify robot assets, create `.env.local` | No |
| `pnpm run doctor` | List missing settings; add `--live` for read-only cloud checks | No (`--live`: yes) |
| `pnpm dev` | Web on 5173, simulator on 8000, evaluator on 8001 | No |
| `pnpm build` | Build every package | No |
| `pnpm typecheck` | Type-check every package (needs the `spacetime` CLI) | No |
| `pnpm lint` | Runs `lint` in every package that defines one (none do yet, so it finishes instantly) | No |
| `pnpm test` | All workspace tests, then Python tests | No |
| `pnpm test:integration` | Integration tests; cloud ones skip without keys | Optional |
| `pnpm test:e2e` | Playwright browser tests against fixture data | No |
| `pnpm benchmark` | Runs the original controller on 10 cases in real MuJoCo and shows it failing (`forbidden_contact`) | No |
| `pnpm seed:demo` | Start a real hosted demo capture (runs physics in Daytona) | Yes, `CONVEX_DEPLOY_KEY` |
| `pnpm deploy:web` | Build the web app and deploy Convex plus static hosting | Yes, deploy owner only |
| `pnpm daytona:prepare` | Build the Daytona snapshots | Yes, `DAYTONA_API_KEY` |
| `pnpm daytona:egress-probe` | Check what a Daytona sandbox can reach | Yes, `DAYTONA_API_KEY` |
| `pnpm smoke:hosted` | Read-only checks of each cloud service you have settings for | Optional; unset services show blocked |
| `pnpm cleanup:sandboxes` | List or remove ForkSafe-labelled Daytona sandboxes | Yes, `DAYTONA_API_KEY` |
| `pnpm release:check` | Pre-release checks | Some |

Python tests on their own: `.venv/bin/pytest -q`. After `node scripts/fetch-assets.mjs`,
run `git checkout assets/robots/manifest.json` because it rewrites a timestamp.

## Learn more

- [How it is built](docs/architecture.md): who owns what, the lifecycle, fencing, outbox, signed results.
- [What is live](docs/integration-matrix.md) and [implementation status](IMPLEMENTATION_STATUS.md).
- [3-minute demo script](docs/demo-runbook.md).
- [Latest test results](docs/verification-report.md).
- [On-call runbook](docs/operations/runbook.md) and [troubleshooting](docs/troubleshooting.md).
- The full spec: [PRD](docs/ForkSafe_PRD_Handoff.md).
