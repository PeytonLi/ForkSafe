# Elastic integration

Elastic is ForkSafe's retrieval and reporting layer. It is never the source of truth: canonical state lives in SpacetimeDB and Convex, and anything Elastic returns is re-checked against canonical authorization before it is shown. Nothing here can change scores, reviews or candidate approval.

Code lives in `packages/integrations/elastic`.

## Modes

| Variable | Values | Needs |
| --- | --- | --- |
| `ELASTIC_MODE` | `cloud`, `local`, `fixture`, `disabled` | `cloud`: `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY` |
| `ELASTIC_AGENT_BUILDER_MODE` | `cloud`, `disabled` | `cloud`: `KIBANA_URL`, `KIBANA_API_KEY` (the Elasticsearch key works) |

Missing credentials report `blocked`, a disabled Agent Builder reports `not_implemented`, and fixture output is always labelled `fixture`.

## Indices

`forksafe-findings`, `forksafe-evidence`, `forksafe-experiments`, `forksafe-candidates`, `forksafe-evaluations` hold projections. `forksafe-index-errors` holds failed indexing results written by `recordIndexErrors`, keyed by a stable hash of (delivery idempotency key, attempt, index, doc id) so retries overwrite instead of piling up. `pnpm --filter @forksafe/elastic bootstrap` creates all of them.

## Agent Builder evidence agent

`ensureAgent()` creates or updates these stable objects in Kibana Agent Builder. It reads each one first, only writes when the definition differs, never deletes, and refuses to overwrite a same-id object of another type or a read-only object.

| Id | Type | Scope |
| --- | --- | --- |
| `forksafe.search_findings` | index_search | `forksafe-findings` |
| `forksafe.search_evidence` | index_search | `forksafe-evidence` |
| `forksafe.search_experiments` | index_search | `forksafe-experiments` |
| `forksafe.investigation_records` | esql | the three indices, filtered by `?investigationId` |
| `forksafe-evidence-agent` | agent | only the four tools above, built-in Elastic tools off |

The agent must cite finding, evidence or experiment ids for every claim, finish with a fenced JSON citation block, and reply `not enough evidence` when the records do not support an answer.

`ask(question, { investigationId })` validates input, calls `POST /api/agent_builder/converse`, parses the citation block, and re-checks every citation with the canonical resolver. Revoked, stale, unauthorized, out-of-scope and unresolved citations are dropped with a reason. If any citation is dropped, or none are valid, the generated prose is withheld and only the authorized citations are returned. Results are always `usage: "evidence_only"` and `scoreAffecting: false`.

Commands: `pnpm --filter @forksafe/elastic agent:ensure` provisions the agent on its own.

## Status and reconcile

`status(client, { now })` returns per-index doc counts, the newest `indexedAt`, its age, and the most recent rows of `forksafe-index-errors`. Missing indices and unreachable indices are reported separately and are never healthy. `fixtureStatus` is the in-memory equivalent.

`reconcile(canonical, client)` takes a canonical list of `{ docType, id, sourceVersion, investigationId }` and reports missing, extra, stale, scope-mismatched and duplicate projections in those investigations. It is read-only, pages with `search_after`, and flags `truncated` instead of claiming `inSync` when it hits its document cap. `reconcileProjections` is the in-memory equivalent.

## Live smoke

`pnpm --filter @forksafe/elastic smoke:agent` with both modes set to `cloud`:

1. Indexes three synthetic records (a finding, one evidence item, an experiment result) in a fresh investigation. Ids start with `synthetic-`, `sourceSystem` is `synthetic-smoke`, and text starts with `[SYNTHETIC]`. No robot is run.
2. Runs `ensureAgent()` twice and requires the second run to be fully unchanged.
3. Runs `status()` and `reconcile()` for the synthetic records.
4. Asks one grounded question. The evidence item is revoked in the smoke's canonical resolver, so the re-check must drop it if the agent cites it.
5. Prints a redacted transcript and deletes exactly the synthetic ids (also filtered by investigation and synthetic source), then confirms nothing is left.

The command exits non-zero when any check fails.
