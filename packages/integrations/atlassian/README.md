# ForkSafe Atlassian integration

This package contains the Jira and Confluence boundary used by ForkSafe's
Atlassian lane. Contracts are imported from `@forksafe/contracts`; the
contracts package is the source of truth for ForkSafe IDs and entity shapes.

## Modes and configuration

`ATLASSIAN_MODE` is parsed by the shared `EnvConfig` contract. Set it to
`fixture` for deterministic in-memory Jira and Confluence responses, or to
`cloud` with all of the following variables for authenticated Jira Cloud and
Confluence Cloud access:

- `ATLASSIAN_SITE_URL`
- `ATLASSIAN_EMAIL`
- `ATLASSIAN_API_TOKEN`
- `ATLASSIAN_PROJECT_KEY`

Missing settings produce `blocked` readiness with variable names only. The
fixture responses are illustrative data, not live Atlassian calls. Never put
an API token in UI code, logs, or a persisted fixture.

## Jira sync and idempotency

`syncInvestigationToJira` identifies an issue with the
`forksafe-inv-<investigation-id>` label. If a prior create response was lost,
the retry searches for that label and adopts the oldest matching issue rather
than creating another. Duplicate matches are returned for reconciliation.
Comments carry a stable operation marker, remote links use a stable global
ID, and the `forksafe.investigation` issue property records the last operation
and investigation version. These independent markers make retries safe across
partial remote failures. Workflow transitions are configured per project and
matched by the site's actual transition/status names; no status name is
assumed.

## Confluence requirements

`ConfluenceClient` fetches a selected page with its version and storage body.
`extractRequirements` returns versioned item IDs and classifies deterministic
limits as checked rules while retaining general human guidance as review
items. It converts millimetres and centimetres into metres. The original text,
page ID, revision, and retrieval time remain attached for traceability.

## Forge invocation token helper

`verifyForgeInvocationToken` verifies Forge Remote Invocation Tokens against
the configured app audience and Forge issuer, then checks `app.id` and maps
installation, environment, principal, and issue context. The authorization
helper accepts only a Bearer token. Installation-context labels require a
trusted injected key set because Atlassian uses an IC-specific JWKS host; the
helper rejects unknown IC key sets rather than guessing a trust endpoint.
