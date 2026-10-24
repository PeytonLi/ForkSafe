# Convex orchestration lane

## Status

The Convex lane is deployed to the hosted development deployment and `/health` reports ready. Unit tests and typechecking pass. Hosted smoke calls reached create, start, claim, heartbeat, ordered stages, and completion. The job was deliberately completed with outcome `failed` to avoid entering evaluation and creating additional work. A separate backend smoke provisioned a Daytona sandbox, ran and polled a command, uploaded its log to Convex storage, and confirmed teardown. These are integration-path checks, not a successful production investigation.

## Architecture

Convex stores investigations, environments, jobs, attempts, ordered handoffs, capacity reservations, sandbox operations and commands, artifacts, outbox records, and system flags. Mutations enforce idempotency, service-token authorization, lease expiry, epoch fencing, cancellation, and handoff ordering. A Workflow component starts environment provisioning; Workpool components bound Daytona and outbox actions. `/health` reports configured integration modes. Artifact HTTP routes use bearer authorization and stream private content through Convex storage, never `storage.getUrl()`.

Service workers call `workers.claim`, `workers.heartbeat`, `workers.recordStage`, and `workers.complete` with `INTEGRATION_SHARED_SECRET`. The current anonymous UI setting is opt-in through `FORKSAFE_DEV_ANONYMOUS_UI`; use authenticated access outside a dev deployment.

## Limits

Heartbeat interval: 5 seconds. Lease expiry: 30 seconds. Maximum attempts: 2. Artifact chunk maximum: 8 MiB. Log tail maximum: 64 KiB. Model calls default to 4 concurrent reservations. Daytona sandbox and environment limits are configurable through Convex environment variables.

## Deployment record

- Deployment name: `lipeyton2006:forksafe:dev/peyton-li` (Convex dev deployment).
- Dashboard: <https://dashboard.convex.dev/t/lipeyton2006/forksafe/giant-jellyfish-684>
- `CONVEX_URL`: <https://giant-jellyfish-684.convex.cloud>
- `CONVEX_SITE_URL`: <https://giant-jellyfish-684.convex.site>
- Environment variable **names** set: `INTEGRATION_SHARED_SECRET`, `DAYTONA_API_KEY`, `DAYTONA_MODE`, `ARTIFACT_MODE`, `DAYTONA_MAX_ACTIVE_SANDBOXES`, `DAYTONA_EXECUTION_CONCURRENCY`, `MAX_ACTIVE_MODEL_CALLS`, `FORKSAFE_DEV_ANONYMOUS_UI`, `DAYTONA_RUNNER_SNAPSHOT`, `DAYTONA_EXECUTION_SNAPSHOT`. Secret values are not recorded here.
- Deployment commands: `pnpm --filter @forksafe/convex codegen` (exit 0) and `pnpm --filter @forksafe/convex dev:once` (exit 0).
- `GET https://giant-jellyfish-684.convex.site/health`: `curl -fsS` exit 0; response reported `ready: true`, admission not paused, Convex functions live, Daytona cloud API key configured, and Convex file storage live. Reported limits were 3 default environments, 10 max environments, 5 max active sandboxes, 3 execution concurrency, and 4 active model calls.
- Hosted lifecycle smoke: after the final deployment, create/start/claim/heartbeat, four ordered stages, and complete all returned successfully in 5,515 ms. The complete call used outcome `failed` intentionally so the hosted smoke would not trigger evaluation or additional jobs/sandboxes. The investigation was then cancelled; its sandbox operation reached `terminated`, and the Daytona cleanup dry-run reported zero owned sandboxes.
- Hosted backend command/artifact smoke: create/start/claim, `runCommand`, `pollCommand`, artifact upload, stages, and complete all ran in 11,814 ms. `python3 --version` exited 0 (`Python 3.12.15`); a 48-byte internal log artifact (`fca44691-423a-441b-8b7a-407d5786a0fc`) was stored in Convex. Completion again used outcome `failed` to prevent downstream evaluation. The operation reached `terminated`; final cleanup dry-run returned `{"mode":"dry_run","ownedCount":0,"sandboxes":[]}`.
- Hosted Workflow debugging surfaced and fixed three errors before the successful runs: `TypeError: Cannot read properties of undefined (reading 'env')` at `../workflows.ts:15:56` (provider lookup in the workflow handler); `ArgumentValidationError: Object contains extra field \`provider\` that is not in the validator` (passing workflow args to `getEnvironments`, whose validator accepts only `investigationId`); and `TypeError: Cannot read properties of undefined (reading 'env')` at `../workflows.ts:26:50` (snapshot lookup in the workflow handler). Provider/snapshot are now passed in workflow arguments, and the query receives only its declared `investigationId` argument.

## Verification

- `pnpm typecheck`: exit 0; contracts, integrations, and Convex TypeScript checks passed.
- `pnpm test`: the contracts, integrations, and Convex Vitest suites passed (9, 6, and 17 tests respectively). The root command then exited 2 because `scripts/pytest.mjs` prints `forksafe: scripts/pytest.mjs is not implemented yet`; that script is outside this lane's write scope.
- `pnpm --filter @forksafe/convex codegen`: exit 0.

## Commands and evidence

```sh
pnpm --filter @forksafe/convex codegen
pnpm --filter @forksafe/convex dev:once
curl -fsS https://giant-jellyfish-684.convex.site/health
```

`.env.local` contains the two public URLs and uncommitted credentials locally; do not commit or print it. The live smoke used `ConvexHttpClient` against `CONVEX_URL` with the service token read from that local file. Completion used the failure outcome for cleanup safety; no successful evaluation/model-turn path is claimed.
