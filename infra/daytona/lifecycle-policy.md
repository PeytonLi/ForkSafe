# Daytona lifecycle policy

## Ownership and capacity

Every cloud sandbox and local container must have `forksafe.project=forksafe`, `forksafe.operation`, `forksafe.purpose`, and `forksafe.investigation` labels. Environment, attempt, and smoke-run identifiers are added when known. Cleanup must select by the project label and verify it again before destroying a resource; never touch resources from another project or resources named `trueforge*`.

The global active-sandbox limit is five, including active reservations and `retained_ambiguous` reservations. The intended allocation is one runner, three execution workspaces, and one evaluator. Convex reservations are the primary gate and the provider checks owned, non-stopped sandboxes before cloud creation. A reservation is released only after termination is confirmed.

## Stop, delete, and cancellation

| Purpose | Auto-stop | Auto-delete |
| --- | ---: | ---: |
| Runner | 30 minutes | 60 minutes after stop |
| Execution | 15 minutes | 60 minutes after stop |
| Evaluator | 15 minutes | 60 minutes after stop |
| Bridge | 10 minutes | 60 minutes after stop |

Persist and verify artifacts before relying on auto-stop or auto-delete. A cancellation request fences the worker immediately, initiates teardown for owned sandboxes, and has a 30-second hard-stop deadline for grant revocation. If the provider cannot confirm creation or deletion after a timeout, preserve the reservation, mark the operation ambiguous, and let reconciliation determine whether the sandbox exists. Never infer that a timed-out request had no effect.

The periodic orphan sweep compares ForkSafe-labelled remote resources with live sandbox operations and destroys only labelled resources with no live operation. Orphan cleanup must not query-and-delete by broad name or organization membership.

## Snapshots and local mode

Snapshot names are versioned and purpose-specific: `forksafe-runner-v1` and `forksafe-exec-v1`. Increment the version when the image contents or runtime contract changes; retain the recorded snapshot ID and build state in `infra/daytona/snapshots.json`. The runner and execution images have resource settings at snapshot creation; the installed SDK does not support overriding resources on snapshot-based sandbox creation.

Evaluation always uses a fresh evaluator sandbox rather than an experiment workspace. Local Docker mode uses the same labels and provider contract but does not consume Daytona quota. A hosted Convex action cannot reach a developer's Docker daemon, so provisioning in local mode is handed to a local worker and readiness is reported as `local`.
