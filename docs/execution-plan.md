# ForkSafe execution plan

Coordinator: lead Devin session (this repo's `main`). Feature work happens in child sessions, each on its own branch and PR into `main`. Only the lead edits `IMPLEMENTATION_STATUS.md`, `docs/execution-plan.md`, and `packages/contracts`.

## Gates

1. **Bootstrap gate (done)**: `pnpm install`, `pnpm typecheck`, `@forksafe/contracts` vitest — green on `main`.
2. **Contract freeze**: `packages/contracts` types/enums/protocol are stable before lane work; lanes may extend, not break.
3. **Integration checkpoint**: after lanes land, lead merges, resolves drift, then a fresh verification session runs the full matrix.

## Lanes (child sessions)

| Lane | Owns (write access) | Depends on |
|---|---|---|
| sim-eval | `services/simulator`, `services/evaluator`, `controllers/`, `evaluation/`, `assets/robots`, python tests | contracts, assets manifest |
| convex | `convex/`, `packages/integrations/daytona`, `infra/daytona` | contracts, hosted Convex project |
| runner | `apps/runner`, `packages/agents` | contracts, FACTORY_API_KEY |
| spacetimedb | `packages/spacetimedb` | contracts, Maincloud login |
| elastic | `packages/integrations/elastic` | contracts, Elastic creds (blocked until provided) |
| atlassian | `apps/forge`, `packages/integrations/atlassian` | contracts, Atlassian creds (blocked until provided) |
| web | `apps/web`, `tests/browser` | contracts, convex client gen |

## Standing rules for lanes

- Never edit `packages/contracts` — request changes through the lead.
- Honest modes only: live/local/fixture/blocked, surfaced through `IntegrationReadiness`.
- UUID application ids only; vendor ids stored as `VendorRef`.
- No shared mutable state between lanes except through `packages/contracts` and the two databases.
