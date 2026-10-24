# OpenTelemetry operations

ForkSafe's Node and in-repo evaluator services export OTLP traces and metrics
only when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured and
`OTEL_SDK_DISABLED` is not `"true"`. The verified Elastic OTLP ingest endpoint
is derived from `ELASTICSEARCH_URL` by replacing `.es.` with `.ingest.`.
Configure credentials through the deployment secret manager; never put the API
key in a command line, checked-in file, or log:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="${ELASTICSEARCH_URL//.es./.ingest.}"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=ApiKey ${ELASTICSEARCH_API_KEY}"
export FORKSAFE_DEPLOYMENT_ENVIRONMENT=production
```

The default environment label is `dev`. To disable an otherwise configured
exporter, set `OTEL_SDK_DISABLED=true`. Node uses OTLP/HTTP `/v1/traces` and
`/v1/metrics` with a batch span processor and a 10-second periodic metric
reader. Shutdown flushes are capped at five seconds.

## Services and trace shape

| Service name | Runtime | Notes |
| --- | --- | --- |
| `forksafe-runner` | Trusted Node runner | Runner job/turn/tool lifecycle |
| `forksafe-evaluator` | FastAPI evaluator process | Manifest, admission, evaluation, and case spans |
| `forksafe-ops` | One-shot `ops:gauges` CLI | Daytona and Convex backlog gauges |

For a claimed runner job, the trace tree is `runner.job` with `runner.claim`,
`runner.grant`, one or more `runner.turn` spans (with `runner.tool` children),
`runner.artifacts`, and `runner.complete`. Claim polls that return no lease are
left unended, so idle polls are not exported. Tool spans contain only tool
name and status; they do not contain tool input or output. The artifacts count
is the number of successful `run_experiment` and `submit_candidate` tool calls.
The runner reports session projections but does not upload artifacts itself;
the Convex control plane and execution sandbox handle artifact storage.

Evaluator requests may propagate a W3C `traceparent`. Evaluator spans include
`evaluator.manifest.verify`, `evaluator.admission`, `evaluator.evaluate`, and
`evaluator.case`. Public cases identify the case by `forksafe.eval.case_id`;
withheld cases use only `forksafe.eval.case_index`, never their case ID.
Simulator children run with a deliberately minimal explicit environment and
receive no `OTEL_*` variables, so only the parent FastAPI process exports.

## Attribute allow-list and redaction

Every helper filters attributes, and the exporters filter again immediately
before export. Span attributes are restricted to:

`forksafe.investigation_id`, `forksafe.environment_id`, `forksafe.job_id`,
`forksafe.attempt_id`, `forksafe.grant_id`, `forksafe.epoch`,
`forksafe.session_id`, `forksafe.vendor_session_id`, `forksafe.turn.index`,
`forksafe.turn.mode`, `forksafe.turn.success`, `forksafe.turn.tool_calls`,
`forksafe.tokens.known`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `forksafe.tokens.cache_read`,
`forksafe.tokens.cache_creation`, `forksafe.tokens.thinking`,
`forksafe.factory_credits`, `forksafe.tool.name`, `forksafe.tool.status`,
`forksafe.tool.is_error`, `forksafe.outcome`,
`forksafe.completion.accepted`, `forksafe.completion.attempts`,
`forksafe.candidate_submitted`, `forksafe.artifacts.count`,
`forksafe.lease.abort_reason`, `forksafe.eval.suite`,
`forksafe.eval.candidate_id`, `forksafe.eval.case_id`,
`forksafe.eval.case_index`, `forksafe.eval.case_status`,
`forksafe.eval.status`, `forksafe.eval.cases`, `http.request.method`,
`http.response.status_code`, `url.path`, and `error.type`.

Values are strings truncated to 256 characters, finite numbers, or booleans.
Metric attributes are restricted to `forksafe.token.kind`,
`forksafe.tool.name`, `forksafe.eval.suite`, and `forksafe.eval.status`.
Span status messages are blanked; exception events are dropped. Registered
secret substrings are scrubbed from span names. Prompts, assistant text, tool
input/output, controller source, withheld case IDs, failure text, and
query-bearing URLs are not exported. No process or host resource detectors or
automatic HTTP instrumentation are enabled.

## Metrics

| Instrument | Type and unit | Behavior |
| --- | --- | --- |
| `forksafe.turns.active` | Up/down counter | Active Factory turns |
| `forksafe.tokens` | Counter | Input/output/cache-read/cache-creation/thinking token totals |
| `forksafe.turns.usage_unknown` | Counter | Turns with unknown token usage; unknown is not reported as zero |
| `forksafe.sandboxes.active` | Observable gauge | Matching ForkSafe Daytona sandboxes, if available |
| `forksafe.outbox.backlog` | Observable gauge | Pending Convex outbox rows, if available |
| `forksafe.evaluation.duration` | Histogram, seconds | Evaluator duration by suite and status |

`pnpm --filter @forksafe/telemetry ops:gauges` is a read-only one-shot
measurement. Sandbox counts require `DAYTONA_API_KEY`; the outbox count uses
`npx convex data outbox --limit 10000 --format jsonl` from `convex/` and
requires `CONVEX_DEPLOY_KEY`. Missing or failed sources remain unobserved
rather than being reported as zero; the output reports `blocked` when the
Convex measurement cannot be obtained.

## Deployment coverage and investigation queries

The in-repo `services/evaluator/app.py` is instrumented. Hosted Convex runner
routes do not emit OpenTelemetry spans; they log a JSON `runner_http` record
containing only the route, trace ID, and parent span ID when a valid
`traceparent` is present. The hosted `evaluator.run_candidate` executed inside
Daytona is part of PR #13 and is not in this repository, so it does not emit
these evaluator spans. That hosted path's manifest-sign step is also not in
this tree; do not infer or instrument it here.

Example Kibana APM service link:

```text
${KIBANA_URL}/app/apm/services/forksafe-runner/overview
```

Example KQL filters:

```text
service.name : "forksafe-runner" and name : "runner.job"
service.name : "forksafe-evaluator" and attributes.forksafe.eval.suite : "public"
```

Example Elasticsearch request for recent runner jobs:

```http
GET traces-generic.otel-default/_search
{
  "size": 20,
  "sort": [{ "@timestamp": "desc" }],
  "query": {
    "bool": {
      "filter": [
        { "term": { "resource.attributes.service.name": "forksafe-runner" } },
        { "term": { "name": "runner.job" } }
      ]
    }
  }
}
```

## Live evidence

- Node smoke trace: `2f58b659870f6442fa163ca48979a9e8`
- Evaluator smoke trace: `67461a0fd0d448368d5717899af78374`
- Hosted investigation: `70b87e29-5374-4065-9aab-1799365b7d9f`
- Environment: `84ea5208-b988-411e-af36-dbb83116e27b`
- Job: `58b23f05-eaf3-4312-be73-4941e8131257`
- Attempts: `e2e60db4-5d95-4c21-8be8-27ff6e4e725b`, `98d36fe4-3017-4619-bdf9-60a324df3454`
- Grants: `3f9be091-1d36-4b73-b96d-42b2fdca0bc2`, `13b1605a-5341-4bc0-8421-e78b334df87e`
- Runner traces: `ae5f095e64e9e69eaec2d6c8945e10bc`, `2c3b27ed38681630fc37f5d08d201a92`
- Factory session: `none`
