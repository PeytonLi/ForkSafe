# @forksafe/elastic

Rebuildable, evidence-only Elastic projections. Canonical records remain in SpacetimeDB; retrieval never edits scores, candidates, or review state. No credentials are logged. Readiness checks are configuration-only; `probeElastic` is an explicit optional network check.

## Modes and configuration

Parse `EnvConfig` from `@forksafe/contracts` (or use `resolveConfig()`). `elasticReadiness(env, now)` and `agentBuilderReadiness(env, now)` return the contracts readiness shape. Inject timestamps in milliseconds.

* `ELASTIC_MODE=cloud`: `ELASTICSEARCH_URL` and `ELASTICSEARCH_API_KEY` required; missing names produce `blocked`.
* `ELASTIC_MODE=local`: optional `ELASTICSEARCH_URL`, default `http://127.0.0.1:9200`; no authentication.
* `ELASTIC_MODE=fixture`: no client; `ElasticIndexer` stores deterministic projections in `store`. Pass `indexer.store.values()` to `ElasticSearch` after indexing for a deterministic fixture snapshot; construct a new search instance to reflect subsequent writes.
* `ELASTIC_MODE=disabled`: readiness `not_implemented`, indexing throws `BlockedError`, search returns `blocked` rather than pretending a successful call.
* `ELASTIC_AGENT_BUILDER_MODE=cloud`: `KIBANA_URL` and `KIBANA_API_KEY` required. Use a dedicated read-only Agent Builder agent/tool configuration and least-privilege API key. The prompt is not an authorization boundary; this package only invokes converse, never tool/agent mutation endpoints. Canonical checks protect returned citations. Agent Builder's UI `read_only` option is not an authorization control.
* Agent Builder `fixture` / `disabled` (`local` also uses fallback): deterministic search-based answer labeled **Deterministic fallback — Agent Builder not used**. Missing cloud credentials never trigger fallback or network requests.

## Bootstrap (local or Serverless)

This nested package requires the local workspace glob `packages/integrations/*` and `pnpm install` before workspace commands can discover it. Node 22.18+ supports the source TypeScript bootstrap directly:

```sh
ELASTIC_MODE=local pnpm --filter @forksafe/elastic bootstrap
# Serverless: export ELASTIC_MODE=cloud, ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY securely
pnpm --filter @forksafe/elastic bootstrap
```

Creates `forksafe-findings`, `forksafe-evidence`, `forksafe-experiments` with strict mappings; existing indices and create races are harmless. Does not migrate existing mappings. `createElasticClient(env)` returns the real Elasticsearch client only for configured live/local modes; callers own closing it. Pass it to `bootstrapIndices`, `ElasticIndexer`, and `ElasticSearch`.

## Indexing and outbox

`toDocuments(record, {idempotencyKey?, sourceVersion?, sourceSystem?, now?})` validates Finding/ExperimentResult, hashes canonical sorted JSON and emits stable IDs. Default `sourceVersion` is the canonical record SHA-256; pass the canonical owner's revision if using revision-based resolution. Provenance defaults to `spacetimedb`, with entity and original ID separate from any vendor identifier. Inject a stable event timestamp for `now`; otherwise the record timestamp is used. Do not inject a changing wall clock on redelivery. Bulk `index` explicitly overwrites stable IDs, so live redelivery may report `updated` with identical bodies. Fixture redelivery reports `noop`. Per-document errors are returned without transport messages; unavailable modes throw `BlockedError`.

Contracts currently call the destination **`elastic_index`**, not `elastic`. `indexer.indexOutboxEntry(entry)` (also exported as `indexOutboxEntry(entry, indexer)`) accepts a validated contracts OutboxEntry:

```ts
{ destination: "elastic_index", idempotencyKey: "stable-outbox-key", payload: {
  kind: "finding", // or "experiment_result"
  record: canonicalRecord
} /* other required OutboxEntry fields */ }
```

The entry key and creation timestamp propagate to every document. Consumer acknowledges delivery only if all per-doc results are non-error; retry failures. Use direct `index` options when the canonical source has a separate revision. Artifacts remain in artifact storage, not in these projections.

## Canonical resolver and search

`new ElasticSearch(mode, resolver, client?, fixtureStore?)` exposes `searchEvidence({query, investigationId, environmentId?, docTypes?, failureKinds?, kinds?, limit?})`. Investigation is mandatory and always an Elastic term filter. Every returned hit is re-resolved, including fixtures:

```ts
interface CanonicalResolver {
  resolve(refs: {docType: "finding" | "evidence" | "experiment_result";
    id: string; investigationId: string; sourceVersion: string}[]):
    Promise<Map<string, {authorized: boolean; revoked?: boolean; deleted?: boolean;
      superseded?: boolean; sourceVersion: string; record: unknown}>>;
}
```

The caller implements authorization for its authenticated principal. `record` must include its canonical `investigationId`; missing scope fails closed. Evidence IDs are `findingId:index`; resolve these to the owning canonical evidence and its finding scope. Return the matching sourceVersion (same projection hash if using default hashes). Unresolved, unauthorized, revoked, deleted, superseded, out-of-scope and stale hits are dropped with reasons; resolver exceptions fail closed. Never trust indexed text/highlights as canonical authority. Elasticsearch relevance scores are retrieval metadata only; this package provides no candidate scoring/write API.

`new AgentBuilder(env, resolver, search, fetch?)` uses documented [converse](https://www.elastic.co/docs/api/doc/kibana/operation/operation-post-agent-builder-converse). `ask({input, investigationId, agentId?, conversationId?})` scopes the question and extracts structured citation references recursively from response/steps (including JSON strings). Citations must carry the four resolver reference fields; arbitrary bare IDs cannot establish freshness. Answers without valid citations, or containing any dropped citation, are withheld; authorized canonical citations remain inspectable. Free-form prose is not a proof of a claim. Deploy a read-only agent whose tools enforce the same investigation scope; this client cannot constrain arbitrary server-side tool configurations. All responses are `usage: evidence_only`, `scoreAffecting: false`.

## Verification

`pnpm --filter @forksafe/elastic typecheck` and `pnpm --filter @forksafe/elastic test` are hermetic; no cluster or Kibana is required.
