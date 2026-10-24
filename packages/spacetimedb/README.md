# ForkSafe SpacetimeDB lane

This package implements the local transactional state lane for ForkSafe. SpacetimeDB is the write authority for grant fences, leases, committed revisions, experiment/finding provenance, immutable candidates, evaluations, reviews, tombstones, and outbox delivery state. Convex remains the orchestration and dispatch owner; it installs grants and consumes outbox events but does not maintain a competing mutable copy of those fields. Reducers perform atomic state changes only; delivery to Convex, Elasticsearch, or Jira remains the responsibility of an outbox consumer.

## Ownership and authorization

The configured `FORKSAFE_BRIDGE_SECRET` is used only by the bridge registration reducer. The secret is compared without returning secret material and must be supplied through the SpacetimeDB module environment, never committed in source or sent to clients. Bridge identity is stored in the private `bridge_identity` table. Bridge reducers use the registered SpacetimeDB identity, not a caller-supplied identity.

Execution grants are installed by a registered bridge and fenced by job, attempt, and epoch. The first valid grant use binds it to `ctx.sender`. Every grant-backed reducer checks revocation/supersession, expiry, attempt and epoch, current fence, operation allowlist, and sender binding. Heartbeat is allowed for every live grant. Revision commits additionally require the matching live environment lease and expected current head. Artifact storage keys and byte use are checked against grant scope.

## Tables and reducers

The module defines `bridge_identity` (private), `job_fence`, `execution_grant`, `revision_head`, `controller_revision`, `revision_lease`, `artifact_ref`, `experiment`, `finding`, `evidence`, `finding_link`, `candidate`, `evaluation`, `human_review`, `outbox_entry`, `tombstone`, and `attempt_heartbeat`.

| Area | Reducers |
| --- | --- |
| Bridge and fencing | `register_bridge`, `unregister_bridge`, `install_grant`, `revoke_grant` |
| Attempt and revision | `heartbeat`, `acquire_revision_lease`, `renew_revision_lease`, `release_revision_lease`, `commit_revision` |
| Evidence and candidates | `record_artifact`, `record_experiment`, `record_finding`, `submit_candidate`, `record_evaluation`, `record_review`, `record_tombstone` |
| Integration delivery | `outbox_enqueue`, `outbox_mark_delivered`, `outbox_mark_failed` |

Reducers are transactional and do not perform external I/O or schedule retries. Outbox rows retain source kind/id, operation identity, idempotency key, payload, and delivery state. Consumers can retry failed delivery and mark it delivered; retries stop at the configured attempt limit.

Reducer error codes include `bridge_required`, `bridge_secret_not_configured`, `bridge_secret_mismatch`, `grant_not_found`, `grant_conflict`, `grant_expired`, `grant_revoked`, `grant_superseded`, `stale_attempt`, `stale_epoch`, `op_not_allowed`, `holder_mismatch`, `scope_mismatch`, `invalid_id`, `invalid_scope`, `invalid_status`, `invalid_artifact`, `invalid_experiment`, `invalid_finding`, `invalid_evaluation`, `invalid_review`, `invalid_outbox`, `invalid_tombstone`, `invalid_idempotency_key`, `lease_required`, `lease_missing`, `lease_held`, `lease_expired`, `revision_conflict`, `revision_missing`, `revision_mismatch`, `duplicate_id`, `artifact_scope`, `artifact_too_large`, `artifact_mismatch`, `artifact_missing`, `experiment_missing`, `finding_missing`, `finding_tombstoned`, `candidate_missing`, `candidate_mismatch`, `sha_mismatch`, `idempotency_conflict`, `immutable_candidate`, `evaluation_final`, `evaluation_not_terminal`, `evaluator_only`, `outbox_missing`, and `outbox_dead`. Reducer errors use the `CODE: message` format.

## Client and integration readiness

`connectForkSafe` wraps the generated TypeScript connection API. The client subscribes to investigation-scoped findings, experiments, candidates, and evaluations, and to the required shared tables for the remaining state. Decoders convert `i64` values to numbers, parse JSON payloads, order evidence by ordinal, validate contract entities, and derive candidate status from candidate/evaluation/review/tombstone rows.

`SPACETIMEDB_MODE`, `SPACETIMEDB_URI`, and `SPACETIMEDB_DATABASE` describe the integration target. Readiness must remain blocked or fixture/not-implemented until a real successful connection is established; configuration alone is not evidence of live readiness.

## Parity notes and requested contract changes

- The SpacetimeDB `finding` row includes a claim and the related `finding_link` rows to preserve provenance. The shared contract `Finding` currently has no claim or links fields; request those fields in `packages/contracts` before removing the lane-specific representation.
- Candidate status is derived from candidate, evaluation, review, and tombstone state; it is not written onto the immutable candidate row. The decoder derives the contract-facing status.

## Development and tests

```sh
pnpm install
pnpm typecheck
pnpm --filter @forksafe/spacetimedb test
pnpm --filter @forksafe/contracts test
spacetime build --module-path packages/spacetimedb
pnpm --filter @forksafe/spacetimedb test:local
```

`test:local` starts an isolated in-memory server on port 3197 by default (override with `PORT`), publishes a uniquely named database, exercises reducer authorization, provenance, fencing, lease, revision, candidate, and outbox behavior, performs SQL assertions, and runs the TypeScript client subscription/decoder check. It stops its own server on success or failure.
