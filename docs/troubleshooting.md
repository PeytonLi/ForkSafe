# Troubleshooting

Start with `pnpm run doctor`. It prints missing variable names, not secret
values. A blocked warning means something needs configuration, not that a
fixture secretly became a live integration.

## pnpm runs its own setup or rejects doctor flags

**Symptom:** bare `pnpm setup` changes pnpm's shell setup, or `pnpm doctor --live`
reports `Unknown option: 'live'`.

**Fix:** use `pnpm run setup` and `pnpm run doctor --live`. These names collide
with pnpm built-ins. Root scripts keep their names; the explicit `run` matters.

## Typecheck cannot find the SpacetimeDB CLI

**Symptom:** `packages/spacetimedb typecheck: SpacetimeDB CLI not found; install CLI 2.13.0 or add it to PATH`.

**Fix:** generated client bindings need the CLI even for a secret-free typecheck.

```sh
curl -sSf https://install.spacetimedb.com | sh -s -- -y
export PATH="$HOME/.local/bin:$PATH"
spacetime --version
pnpm typecheck
```

Keep the CLI compatible with the package toolchain (currently 2.13.x). If the
installer later selects another release, use the CLI's version management to
select the matching version rather than changing package dependencies blindly.

## Asset SHA mismatch or manifest timestamp churn

**Symptom:** missing robot XML/assets, `Robot asset SHA mismatch`, or a changed
`fetchedAt` after fetching.

**Fix:** run `pnpm run setup` for missing assets. It fetches the pinned Menagerie
commit and verifies the file tree against `assets/robots/manifest.json`.
Setup restores timestamp-only manifest churn only when its starting manifest
matched HEAD and the SHA is unchanged. Existing local changes are preserved.
Do not commit a timestamp-only update.

A SHA mismatch is not fixed by blessing a new hash. Preserve any intentional
local edits, then restore the pinned asset tree and retry. Do not replace the
manifest hash to make verification green. The expected tree SHA is
`bcf7166c368900f13a2d4cd66f380b1502c2414960f6820b19d8774b0a15189a`.

## A development port is busy

**Symptom:** root dev fails with `Port 5173 busy` (or 8000/8001), or Playwright
cannot start its webServer.

**Fix:** stop the earlier dev session with Ctrl-C. Use
`ss -ltnp '( sport = :5173 or sport = :8000 or sport = :8001 )'` to identify an
owner before stopping it; do not kill unrelated processes. Root dev stops all
its process groups together. Playwright starts Vite itself, so stop `pnpm dev`
before running CI-style e2e tests. CI disables reuse of an existing web server.

## Local Convex fails on glibc 2.35

**Symptom:** the downloaded local Convex backend cannot run on this Ubuntu VM's
glibc. This was observed during bootstrap.

**Fix:** use the authorized hosted development deployment and label it as hosted,
or move the local backend to a compatible OS/container. Do not replace the host's
system glibc. Set `CONVEX_URL`, `VITE_CONVEX_URL` and `CONVEX_SITE_URL`; use
`pnpm run doctor --live`. Root `pnpm dev` does not launch a Convex backend.
For UI work without a backend, explicitly select fixtures.

## Daytona reaches the five-sandbox cap

**Symptom:** provisioning is refused or work waits despite a valid API key.

**Fix:** check the organization's actual quota in Daytona. The development
configuration budgets five active sandboxes and three concurrent executions;
runner sandboxes also use capacity. Keep within that budget instead of raising
concurrency to bypass it. Inspect owned resources first:

For shared live checks, also follow the stricter current
[Daytona lane safety limit](integrations/daytona.md): at most two ForkSafe
snapshots and one ForkSafe sandbox at a time. The account cap is not permission
to consume every slot.

```sh
pnpm cleanup:sandboxes
# Only after reviewing the owned list and ending any active ForkSafe runs:
pnpm cleanup:sandboxes --yes
```

The root cleanup filter requires the exact `forksafe.project=forksafe` label
and excludes `trueforge*` names. Never remove another project's resources to
make room. Dry-run success does not establish cloud provisioning success.

## Secrets exist in a manager but not in this shell

**Symptom:** doctor shows missing key names even though another session used them.

**Fix:** inject the required values into this process through the approved secret
manager, or put them in ignored `.env.local`. A credential-bound command does not
export credentials into future shells. Root scripts preserve nonempty process
values over `.env.local`, then `.env`. Never print values to diagnose this.
Hosted Convex/worker environment variables must be configured separately.

Keep secrets out of `VITE_*`: those values can enter browser bundles.
The Forge app ID is public and does not authenticate anything.

## Doctor is green but the demo is still a fixture

**Symptom:** HTTP probes pass while the web banner says recorded fixture data,
or Factory says `not_verified`.

**Fix:** treat these as different checks. The web needs `VITE_CONVEX_URL` and no
`VITE_FORKSAFE_DATA=fixture` override to select its hosted client. Restart Vite
after changing env values. A connected backend still needs its deployment,
auth and data configured. Do not remove the fixture label or describe recorded
replays as a live repair.

Factory model discovery accepted an invalid key in our negative-control check;
it is intentionally not used as an authentication probe. Read the
[integration matrix](integration-matrix.md) before making a live claim.

## Kibana probe passes but the package Agent Builder is blocked

Root ops prefers `ELASTICSEARCH_API_KEY` and only falls back to `KIBANA_API_KEY`.
The package Agent Builder contract currently requires `KIBANA_API_KEY`
separately. Bind the same authorized Serverless key to that name if it has the
needed Kibana permissions. Use the base Kibana URL, not an `/app/...` route.
Listing agents is not the same as running a scoped, cited converse request.

## Lockfile conflicts or frozen install fails

**Symptom:** pnpm reports an outdated lockfile or merge markers.

**Fix:** use the `packageManager` version (pnpm 10.34.8). Resolve the actual
`package.json` changes with the lane that owns them, then regenerate
`pnpm-lock.yaml` with that version and review it. Verify with
`pnpm install --frozen-lockfile`. Do not delete the lockfile, upgrade everything,
or weaken CI's frozen install to hide a conflict.

pnpm can also warn `Ignored build scripts` for dependencies. On this VM that
was pnpm's lifecycle-approval policy, not a missing environment: frozen install,
build and tests worked. If a native dependency actually fails, review the needed
scripts and approval policy with the repo owner; do not approve all scripts
blindly or edit shared config from an unrelated lane.

## Missing Python environment, Chromium, or seed module

- `Python .venv missing`: run `pnpm run setup`; Python must be 3.12.
- Playwright cannot find a browser: run
  `pnpm --filter @forksafe/web exec playwright install --with-deps chromium`.
  The dependency step may need administrator rights on your machine.
- `convex/demo.ts not on main yet (pipeline lane)`: `pnpm seed:demo` exits 2
  intentionally. It cannot create a hosted demo until that lane supplies the
  seed module. Use the explicitly labelled fixture tour; do not claim it seeded
  cloud data.
- Benchmark prints `completed=false`, `forbidden_contact`: this is the expected
  baseline collision, not an ops failure. A parseable run exits 0.
- Python tests currently emit an upstream Starlette/httpx deprecation warning;
  it did not prevent the 21-test suite from passing.
- Vite warns about a large bundle: the production build succeeds; the replay
  viewer includes Three.js. This warning is not a failed deployment or test.

If a configured live probe fails, keep its HTTP status and missing-name output,
not its response body or headers. Share that safe output with the integration
owner rather than retrying writes against a shared service.
