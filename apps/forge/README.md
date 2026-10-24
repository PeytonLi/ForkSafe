# ForkSafe Jira Forge app

The Forge app adds a native Jira issue panel for investigation readiness,
progress, versioned requirements, candidate comparison, and exact-hash human
review. The issue action starts an investigation using Jira context supplied by
Forge; browser payloads never choose the Jira issue, project, or reviewer.

## Setup and permissions

The manifest requests only `read:jira-work`, the least-privilege Jira scope
needed for issue context. It configures the `forksafe-backend` Forge Remote
with `compute` and `storage` operations, and opts out of in-scope EUD storage.
Outbound egress is limited to the declared `forksafe-backend` remote; no
unrestricted external host is configured.
The browser calls resolver functions through `@forge/bridge`; the resolver
calls the remote backend using Forge Remote and its Invocation Token. Shared
backend secrets are never sent to the browser. The backend contract paths and
schemas are exported from `@forksafe/integrations-atlassian`.

## Registered app

The app is registered under Developer Space **Peyton ForkSafe** with ID
`ari:cloud:ecosystem::app/66bb7292-9ddc-4529-aa0f-db7b15fc667a`.

## Modes

By default the Forge app uses clearly labeled deterministic fixture data.
Set `FORKSAFE_BACKEND_MODE` to `remote` after configuring the remote to use the
ForkSafe Convex HTTP endpoint. Other values continue to select fixture mode.
The fixture is illustrative and is not a live Jira or ForkSafe investigation.

## Development install

From this directory:

```sh
forge login
CONVEX_SITE_URL=https://<deployment>.convex.site node scripts/configure-remote.mjs
forge variables set FORKSAFE_BACKEND_MODE remote
pnpm --filter @forksafe/forge build
forge deploy -e development --non-interactive
forge install --site <site>.atlassian.net --product jira -e development
```

Configure the remote URL before deployment; `configure-remote.mjs` only updates
that URL and rejects non-HTTPS values. Build the resolver bundle before
deployment. Deploy and install only into an authorized development site.

## Demo

1. Open an issue in the installed Jira development site.
2. Open the **ForkSafe investigation** issue panel and confirm mode/readiness.
3. Use **Start ForkSafe investigation** from the issue action and select
   environment count and an optional Confluence requirements page ID.
4. Review environment and candidate evidence, including the requirements page
   revision and full controller SHA-256.
5. Submit an approve/reject/needs-changes decision with notes. The resolver
   takes reviewer identity from Forge's `context.accountId` and records the
   review only against the exact evaluated hash.

Run `pnpm typecheck`, `pnpm test`, and the Forge CLI's `forge lint` from this
directory during development.
