# ForkSafe implementation status

Lead coordinator: Devin session https://app.devin.ai/sessions/18c7f881146e4e33b07213d7305c31d2 (lead). Feature work is delegated to child sessions; only the lead edits this file.

## Phase

Phase 1 — environment and contracts bootstrap (lead acting as Environment and Contracts Agent).

## Environment facts (verified 2026-10-24 on the lead VM, Ubuntu x86_64)

| Tool | Version / location |
|---|---|
| Node | 22.23.4 (`/opt/hostedtoolcache/node/22.23.4/x64/bin`) |
| pnpm | 10.34.8 |
| Python | 3.12.13 (pyenv); uv 0.13.5 |
| Docker | present (`/usr/bin/docker`), daemon running |
| SpacetimeDB CLI | 2.13.0 (`~/.local/bin/spacetime`, installed via install.spacetimedb.com) |
| Factory `droid` CLI | 0.249.0 (`~/.local/bin/droid`, installed via app.factory.ai/cli) |
| MuJoCo (pip) | 3.17.0 imports under Python 3.12 |
| MuJoCo Menagerie | pinned commit `f3b6013629c7b94f8ee93fd977b161fa8350f9bc` (franka_emika_panda/panda.xml, scene.xml present) |

Latest npm versions seen at bootstrap: convex 1.48.0, @convex-dev/workflow 0.4.10, @convex-dev/workpool 0.4.14, @factory/droid-sdk 0.10.0, @daytonaio/sdk 0.226.1, spacetimedb (npm, TS module+client) 2.13.0, @elastic/elasticsearch 9.5.1, zod 4.6.7 (Factory tool schemas must stay on zod 3.x), three 0.186.1, vite 8.3.5.

## Integration modes

| Integration | Mode | Note |
|---|---|---|
| Factory | fixture until FACTORY_API_KEY is provided | secret requested from Peyton 2026-10-24 |
| Daytona | local container adapter until DAYTONA_API_KEY | secret requested |
| Convex | local anonymous dev deployment | CONVEX_DEPLOY_KEY requested for hosted |
| SpacetimeDB | local CLI instance | no credential needed |
| Elastic | local Elasticsearch (docker) | Serverless URL/API key + KIBANA_URL requested for Agent Builder |
| Atlassian | fixture | ATLASSIAN_EMAIL/API_TOKEN/SITE_URL/PROJECT_KEY requested |

## Blockers

- No sponsor credentials configured yet (names above). Local work proceeds.

## Next action

Scaffold monorepo + shared contracts, verify Panda physics step, publish ownership, then launch feature sessions.

## Progress log

- 2026-10-24: Repo created; handoff docs committed. Toolchain verified: spacetime 2.13.0, droid 0.249.0, MuJoCo 3.17.0 imports, Panda assets pinned (menagerie f3b6013, tree sha256 bcf7166c). Local Convex binary unusable on glibc 2.35 — plan switched to hosted/cloud for all integrations per Peyton. FACTORY_API_KEY + DAYTONA_API_KEY received. `packages/contracts` landed with entity schemas, handoff protocol, env validation; 9 vitest tests green; doctor reports missing names only.
