# Always-on runner pool

The runner pool lets an investigation started in the hosted app get a runner
without someone launching one by hand. Convex owns the queue and hands one
short-lived, environment-scoped credential to a pool worker at a time. The
pool starts the existing runner process; experiments still run in Daytona
execution sandboxes.

## What you need

Set these environment variables on the Render worker:

| Name | Purpose |
| --- | --- |
| `FACTORY_API_KEY` | Lets Droid start Factory sessions. |
| `RUNNER_POOL_TOKEN` | Private service token shared with the Convex deployment. Create a new random value and set the same value on both sides. |
| `CONVEX_SITE_URL` | Hosted Convex HTTP URL, such as `https://giant-jellyfish-684.convex.site`. |
| `POOL_MAX_RUNNERS` | Optional maximum concurrent runner children; defaults to `4`. |

On Convex, set `RUNNER_LAUNCH_MODE=external` and the same
`RUNNER_POOL_TOKEN`. Do not use `INTEGRATION_SHARED_SECRET` as the pool token.
The pool token is only for the pool's claim and release requests; child runners
receive a separate scoped credential in their environment.

## Render setup

1. Create a **Background Worker** from this repository.
2. Use the repository root as the Docker build context and
   `deploy/runner-pool/Dockerfile` as the Dockerfile. The checked-in
   `deploy/runner-pool/render.yaml` contains those settings.
3. Add the environment variables above in Render. Keep secret values private;
   do not put them in the YAML or a log.
4. Start with one instance and `POOL_MAX_RUNNERS=4`. Increase capacity only
   after checking Factory usage and the shared model-call limits.
5. Deploy the worker, then start a small hosted investigation. The worker
   checks Convex about every five seconds when idle and should pick up an
   eligible environment automatically.

The image installs Node 22, pnpm 10.34.8 for the build, the bundled ForkSafe
runner, and the official Droid CLI. It does not include Python or MuJoCo:
Convex sends experiment work to Daytona execution sandboxes.

## Health and shutdown

The process serves `GET /healthz` on `PORT` (default `8080`) with its active
runner count. A background worker is not a public web service, so this endpoint
is for the platform or private diagnostics.

On shutdown, the pool forwards `SIGTERM` to each runner, waits for them to
drain, and asks Convex to release clean exits. It does not restart failed
children itself. Convex's credential expiry, job reconciliation, and roughly
90-second pool lease allow another worker to take over after a worker dies.

## If no runner starts

- Confirm Convex has `RUNNER_LAUNCH_MODE=external` and `RUNNER_POOL_TOKEN`.
- Confirm the Render worker has `RUNNER_POOL_TOKEN`, `CONVEX_SITE_URL`, and
  `FACTORY_API_KEY`; token values must match exactly.
- Check that the investigation is still searching and its Daytona execution
  sandbox is ready. The pool will not claim an environment before then.
- Check `/healthz` and Render logs. The pool never logs claim credentials.
- Do not copy a runner credential into a shell, ticket, or log. If a worker
  disappears, allow the lease and normal reconciliation to fence its old job.
