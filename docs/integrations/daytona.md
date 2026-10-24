# Daytona integration

## Ownership and safety

Every managed resource carries `forksafe.project=forksafe` and an operation identifier. Cleanup is ownership-scoped; it must not list-delete or otherwise modify unlabelled resources or `trueforge` resources. The requested live limit is no more than two ForkSafe snapshots and one ForkSafe sandbox at a time. Every smoke-created sandbox must be destroyed and confirmed absent.

## Modes

- `cloud`: Convex actions use the Daytona SDK with `DAYTONA_API_KEY`.
- `local`: the Docker provider is intended for a local worker, not a hosted Convex action.
- Artifact transport is separately configured by `ARTIFACT_MODE`.

The runner Dockerfile leaves the optional Droid CLI disabled by default because the upstream installer is not pinned. The execution image pins MuJoCo and NumPy dependencies.

## SDK compatibility

Installed `@daytonaio/sdk` 0.226.1 declares `Daytona.create(params, options?)`, where the timeout is in the second argument. Snapshot-based sandbox creation accepts `envVars` but no per-sandbox `resources`; CPU, memory, and disk therefore belong to the snapshot build plan. The `list()` method returns an async iterator. Snapshot creation accepts `resources`, `Image.fromDockerfile()` is present, and deletion takes a `Sandbox` object.

The installed SDK declarations do not expose an organization quota endpoint. The REST `GET /api/organizations` quota probe returned HTTP 401. The safer `GET /api/sandbox` listing returned HTTP 200 and zero sandboxes, including zero ForkSafe-labelled or active ForkSafe sandboxes. This confirmed the observed sandbox count, not the organization's quota; the smoke was kept to one ForkSafe sandbox at a time. Snapshot preparation reports observed ForkSafe-named snapshots and ForkSafe-labelled sandboxes and refuses to build if any ForkSafe sandbox exists or more than two ForkSafe-named snapshots are present.

## Live record

- Quota/list observations before creation: `GET /api/organizations` HTTP 401; `GET /api/sandbox` HTTP 200, zero sandboxes and zero ForkSafe-owned sandboxes. No `trueforge*` resources were modified.
- `pnpm daytona:prepare`: exit 0. Both requested snapshots are active:
  - `forksafe-runner-v1`, ID `06355f66-f6a0-416a-bced-c28a711af037`.
  - `forksafe-exec-v1`, ID `e8ce44ba-ce7c-4931-bcc7-3ea3cc628789`.
- `pnpm daytona:smoke`: exit 0. Run `21b79c1b-db0d-4853-a33d-07d2bf903e6e` ran MuJoCo 3.17.0 for 500 steps; `finalZ=0.09989224448747304`, four contacts. Timings: startup 2,301 ms, execution 503 ms, destroy 1,126 ms. The provider confirmed destruction.
- Hosted Convex lifecycle: create/start/claim/heartbeat and four ordered stages completed; the completion call intentionally used outcome `failed` to avoid triggering evaluation and further sandbox work. End-to-end call elapsed time was 5,515 ms.
- Hosted backend provisioning: operation `71c4457f-b739-4b53-8534-26512390083b` provisioned one execution sandbox. Through Convex `runCommand`/`pollCommand`, `python3 --version` exited 0 and returned `Python 3.12.15`; the 48-byte internal log artifact was uploaded to Convex storage. Completion used outcome `failed` for the same safety reason, then cancellation terminated the sandbox. This provisioning/command/artifact/teardown smoke took 11,814 ms.
- `pnpm --filter @forksafe/integrations daytona:cleanup --dry-run`: exit 0 after the physics smoke and hosted attempts. Final output was `{"mode":"dry_run","ownedCount":0,"sandboxes":[]}`; the hosted operation was also confirmed `terminated`.
- Snapshot and smoke resources stayed within the cap of two ForkSafe snapshots and one ForkSafe sandbox alive at a time.

## Commands

```sh
pnpm daytona:prepare
pnpm daytona:smoke
pnpm --filter @forksafe/integrations daytona:cleanup --dry-run
```

The runner image leaves the optional Droid CLI disabled because the upstream installation is not pinned. The smoke sandbox was destroyed and confirmed absent; final dry-run count was zero.
