# Integration modes and limits

This page separates working code, recorded fixtures and observed cloud health.
A green read-only check means that endpoint answered with those credentials at
the time of the check. It does not mean a full investigation completed.

## Reading a mode

Configuration generally uses `cloud`, `local`, `fixture` or `disabled`.
Readiness reports `live`, `local`, `fixture`, `blocked` or `not_implemented`.
Cloud configuration without required variables is blocked. A configured cloud
integration may be labelled live before a probe runs; use `doctor --live` to
check reachability, not just the mode label.

- **live**: configured cloud adapter; look for a separate successful probe.
- **local**: local configuration, not automatic proof a local service is running.
- **fixture**: deterministic recorded/in-memory behavior, not a cloud result.
- **blocked**: missing prerequisites; no silent fallback to pretend success.
- **not_implemented**: disabled or unsupported behavior.
- **not_verified** is a probe result, not an additional mode. Factory currently
  uses it even when configured as live.

Root doctor is an operational view. Package adapters use their own contract
validation and can be more restrictive. In particular, the root Kibana probe
accepts the shared Elasticsearch key while the package Agent Builder contract
still requires `KIBANA_API_KEY`.
The shared Convex readiness contract also requires `CONVEX_ADMIN_KEY` in cloud
mode, while root ops can probe public health using just a URL. A development
`CONVEX_DEPLOY_KEY` is not a substitute for an admin credential. This is a
readiness-contract discrepancy, not evidence that health needs administrator
access.

## Current evidence

The ops lane's credential-bound `pnpm run doctor --live` and
`pnpm smoke:hosted` returned HTTP 200 for Convex, SpacetimeDB discovery, Daytona,
Elastic, Kibana agents listing and the Jira project. Opt-in integration tests
also passed for Convex, Elastic, Jira and Maincloud. These were read-only calls:
no new cloud sandbox, issue, Forge installation or agent repair was established
by these checks. Rerun them before your own demo; this is not a service guarantee.

| Integration | Configuration and reported modes | Environment variables | Observed live behavior | Fixture/local behavior and limits |
| --- | --- | --- | --- | --- |
| Web | Hosted client if URL is set; explicit fixture override wins. | `VITE_CONVEX_URL`, `VITE_FORKSAFE_DATA=fixture` | Hosted browser mutation flow not established by ops health checks. | Recorded investigation/replay/comparison story; reviews persist in browser storage. Fixture capture explicitly refuses to run physics. |
| Convex | `CONVEX_MODE=cloud/local/fixture/disabled`; reports live/local/fixture/not_implemented, or blocked. | `CONVEX_URL`, `VITE_CONVEX_URL`, `CONVEX_SITE_URL`; `CONVEX_DEPLOY_KEY` for CLI deployment/seed; server `INTEGRATION_SHARED_SECRET` and bridge secrets where required. | Site `GET /health` returned 200 without an admin key. | Lifecycle exercised in `convex-test`, including create/start retries and fail-closed auth. Web fixtures do not run a Convex backend. `pnpm dev` does not start one; this VM's local backend is blocked by glibc. |
| SpacetimeDB | `SPACETIMEDB_MODE=cloud/local/fixture/disabled`; reports live/local/fixture/not_implemented, or blocked. | `SPACETIMEDB_URI`, `SPACETIMEDB_DATABASE`; `SPACETIMEDB_TOKEN` if needed by client; server `FORKSAFE_BRIDGE_SECRET`. | Maincloud `GET /v1/database/forksafe` returned 200. | Real client decoders tested against contract schemas without a server. Discovery does not verify authenticated subscriptions, grants or writes. Local server is not started by root dev. |
| Daytona | `DAYTONA_MODE=cloud/local/fixture/disabled`; reports live/local/fixture/not_implemented, or blocked. | `DAYTONA_API_KEY`, optional `DAYTONA_API_URL`; runner/execution snapshot names; max-active/concurrency settings. | Read-only `GET /sandbox` returned 200; cleanup dry-run found no owned sandboxes. | Adapter has local execution support. Fixture mode is not evidence of cloud provisioning. Image preparation, resource caps and actual cloud physics need separate verification. |
| Factory Droid | `FACTORY_MODE=cloud/local/fixture/disabled`; configured cloud reports live with probe result not_verified. | `FACTORY_API_KEY`, optional `FACTORY_MODEL`; Droid CLI on PATH. | No verified cheap authenticated read-only probe. SDK `listModels` returned 60 models for an intentionally invalid key. | Fixture agent behavior is deterministic and must be labelled. Model discovery or key presence does not establish a real Factory session/tool round trip. |
| Elastic | `ELASTIC_MODE=cloud/local/fixture/disabled`; reports live/local/fixture/not_implemented, or blocked. | `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY`. | `GET /` returned 200. | Fixture indexer stores projections in memory; identical retries return noop. Real contracts validate canonical inputs and projected finding fields. Health does not prove index mappings, indexing, retrieval permissions or freshness. |
| Kibana Agent Builder | `ELASTIC_AGENT_BUILDER_MODE=cloud/local/fixture/disabled`; reported readiness depends on the adapter. | `KIBANA_URL`; root uses `ELASTICSEARCH_API_KEY` first, optional `KIBANA_API_KEY` fallback. Package Agent Builder requires `KIBANA_API_KEY`. | `GET /api/agent_builder/agents` returned 200. | Fixture/deterministic fallback is labelled “Agent Builder not used.” No web chat panel exists. Agents-list success does not verify converse, tool scope or canonical citations. Answers never determine evaluator scores. |
| Jira | `ATLASSIAN_MODE=cloud/local/fixture/disabled`; reports live/local/fixture/not_implemented, or blocked. | `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`, `ATLASSIAN_PROJECT_KEY`. | `GET /rest/api/3/project/<key>` returned 200. | Actual fixture transport tested for idempotent issue sync and invalid inputs. Project access does not establish issue writes, transitions or installed Forge UI. Workflow status names are project-specific. |
| Confluence | Shares `ATLASSIAN_MODE`; package readiness is distinct from Jira. | Same Atlassian account/site settings; selected requirements page ID supplied to the workflow. | Not separately probed by root ops. | Fixture page transport and versioned requirements extraction exist. Live page permissions and revision retrieval remain separate checks; Jira success is not Confluence success. |
| Forge | Root doctor checks app ID configuration, not installation; supports its generic mode classification via `FORGE_MODE`. App itself uses fixture by default or `FORKSAFE_BACKEND_MODE=remote`. | Public `FORGE_APP_ID`; Forge login, installation and remote deployment configuration. | No Forge deployment/installation verified by ops. | Native issue panel/action code exists. Registered app ID is public; manifest remote defaults to a placeholder. Fixture panel is illustrative, not a live investigation. |
| Simulator / evaluator / Python | `SIMULATOR_MODE=cloud/local/fixture/disabled`; root recognizes loopback service URLs as local. | `SIMULATOR_URL`, `EVALUATOR_URL`, `EVALUATOR_SERVICE_TOKEN` for protected operations. | Local services' `/health` endpoints returned healthy; benchmark ran real MuJoCo and reproduced forbidden_contact. | Python tests use pinned assets. Browser fixture replays are separate. Root dev starts these locally, not inside cloud sandboxes; evaluator benchmark module is currently absent, so benchmark uses simulator fallback. |
| Artifacts | `ARTIFACT_MODE=local/cloud/fixture/disabled`; root defaults local. | `ARTIFACT_ROOT` for local files; `CONVEX_URL` for cloud configuration; adapter auth settings as appropriate. | Cloud upload/download not verified by read-only health. | Local artifacts under `var/artifacts`; fixture references are not proof of an uploaded immutable artifact. |

## Checks you can repeat

```sh
pnpm run doctor
pnpm run doctor --live
pnpm smoke:hosted
pnpm test:integration
INTEGRATION_LIVE=1 pnpm test:integration
```

Blocked integrations warn by default. Failed configured live probes fail doctor;
`--strict` also fails on blocked rows. Integration tests require
`INTEGRATION_LIVE=1` for network calls and print missing variable names when a
service is skipped. Neither test command needs cloud credentials for offline
contract coverage. `pnpm test` separately runs workspace Vitest and Python suites.

For configuration steps see the [README](../README.md); for presentation boundaries
see the [demo runbook](demo-runbook.md).
