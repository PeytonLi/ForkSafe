# Orchestration handoff

## Current state

The Convex schema, lifecycle mutations, pure handoff/lease/reservation/auth/command-policy helpers, workflow and workpool configuration, sandbox adapters/actions, artifact HTTP routes, outbox dispatch, Daytona scripts, and hermetic tests are implemented on `devin/forksafe-convex`. A hosted five-second cron now invokes `internal.reconcile.tick`; it is the only recurring reconcile trigger. Root typechecking and all workspace Vitest suites pass. The hosted dev deployment is live and its health endpoint reports ready. Hosted lifecycle calls reached create/start/claim/heartbeat/four ordered stages/complete, and the separate hosted backend path provisioned a Daytona sandbox, ran and polled `python3 --version`, uploaded a log artifact to Convex storage, and terminated the sandbox. Both smoke jobs were deliberately completed with outcome `failed` to prevent downstream evaluation and extra work; they do not claim a successful investigation outcome.

## Vendor API notes

- Convex, `@convex-dev/workflow`, `@convex-dev/workpool`, `convex-test`, and Daytona calls used in this lane were checked against the installed package declarations. Convex generated `api`/`internal` references, function builders, scheduler calls, and Convex storage HTTP handlers are used in their declared forms.
- Installed Convex 1.48.0 exposes `cronJobs()` and `Crons.interval(identifier, { seconds }, functionReference, ...args)` in `dist/cjs-types/server/cron.d.ts`; runtime validation requires a positive integer interval, so five seconds is valid. The cron passes `{}` to `reconcile.tick`; no caller passes `scheduleNext: true`.
- Workflow 0.4.x uses `WorkflowManager(components.workflow)`, `.define(...).handler(...)`, `step.runQuery`/`step.runMutation`, and `workflow.start(ctx, reference, args, { startAsync: true })`.
- Workpool 0.4.x uses `Workpool(components.<pool>, { maxParallelism })` and `enqueueAction(ctx, internal.action, args)`. `convex-test` 0.0.65 exports `convexTest(schema, modules)`; the tests register the Workflow and Workpool component helpers so they remain hermetic.
- Daytona SDK 0.226.1: `Daytona.create(params, options?)` takes `{ timeout }` in its second argument. Snapshot-based sandbox creation accepts `envVars` but has no per-sandbox `resources`, so CPU/memory/disk are set while building snapshots. `list()` is an async iterator; snapshot creation accepts resources; `Image.fromDockerfile()` exists; deletion takes a `Sandbox` object.
- The installed Daytona SDK has no organization quota method. REST `GET /api/organizations` returned HTTP 401; `GET /api/sandbox` returned HTTP 200 with zero sandboxes before creation. This is an observed sandbox count, not an authoritative organization quota.

## Verification and live record

- `pnpm typecheck`: exit 0.
- `pnpm test`: contracts 9/9, integrations 6/6, and Convex 17/17 Vitest tests passed; root command then exited 2 because `scripts/pytest.mjs` reports `forksafe: scripts/pytest.mjs is not implemented yet`. That script is outside the lane write scope.
- Convex `codegen` and `dev:once`: exit 0. Deployment: `lipeyton2006:forksafe:dev/peyton-li`; `CONVEX_URL=https://giant-jellyfish-684.convex.cloud`; `CONVEX_SITE_URL=https://giant-jellyfish-684.convex.site`. A `curl -fsS <site>/health` returned ready with Convex, Daytona cloud configuration, and file storage marked live.
- Hosted workflow debugging exposed three errors, all fixed before the final successful smoke: `TypeError: Cannot read properties of undefined (reading 'env')` at `../workflows.ts:15:56` from reading provider mode inside the Workflow handler; `ArgumentValidationError: Object contains extra field \`provider\` that is not in the validator` because `getEnvironments` accepts only `investigationId`; and `TypeError: Cannot read properties of undefined (reading 'env')` at `../workflows.ts:26:50` from reading the snapshot environment variable inside the Workflow handler. The handler now receives provider and snapshot as arguments, and `getEnvironments` receives only `{ investigationId }`.
- Hosted lifecycle smoke after the corrected deployment: create/start/claim/heartbeat/four ordered stages/complete returned successfully in 5,515 ms. Completion used outcome `failed` to avoid downstream evaluation; cancellation followed.
- Hosted backend command/artifact smoke: `python3 --version` returned exit 0 and `Python 3.12.15`; its 48-byte internal log artifact (`fca44691-423a-441b-8b7a-407d5786a0fc`) was stored in Convex. Total time was 11,814 ms. Cancellation led sandbox operation `71c4457f-b739-4b53-8534-26512390083b` to `terminated`; the final cleanup dry-run returned zero owned sandboxes.
- `pnpm daytona:prepare`: exit 0; active snapshots `forksafe-runner-v1` (`06355f66-f6a0-416a-bced-c28a711af037`) and `forksafe-exec-v1` (`e8ce44ba-ce7c-4931-bcc7-3ea3cc628789`).
- `pnpm daytona:smoke`: exit 0; MuJoCo 3.17.0, 500 steps, `finalZ=0.09989224448747304`, four contacts; startup 2,301 ms, execution 503 ms, destroy 1,126 ms. Destruction was confirmed.
- Final `pnpm --filter @forksafe/daytona daytona:cleanup --dry-run`: exit 0, `ownedCount: 0`, empty list. No `trueforge*` resources were touched.

## Remaining verification and operational work

The root `pnpm test` command remains blocked after all workspace Vitest suites pass because the out-of-scope `scripts/pytest.mjs` prints `forksafe: scripts/pytest.mjs is not implemented yet` and exits 2. Do not change that runner without scope authorization.

Generated `convex/_generated` is gitignored by the repository and was force-added after generation. `packages/contracts` and secret-bearing files were not added. No PR has been opened.
