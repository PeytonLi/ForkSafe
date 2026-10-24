# @forksafe/web

Browser workspace for ForkSafe investigations: baseline capture and scenario editor, environment grid, shared evidence feed, candidate comparison with synchronized Three.js replays, and human review bound to the exact `controllerSha256`.

## Run

    pnpm --filter @forksafe/web dev        # http://localhost:5173
    pnpm --filter @forksafe/web build
    pnpm --filter @forksafe/web test       # unit tests (replay transforms)
    pnpm test:e2e                          # Playwright browser story (tests/browser)

## Data boundary

Every component reads through `src/services` (`ForkSafeClient`). Shapes are validated against `@forksafe/contracts` before rendering.

- Convex mode: used when `VITE_CONVEX_URL` is set. Expects these Convex functions from the convex lane: `investigations:list`, `investigations:workspace`, `evidence:findings`, `artifacts:replay`, `candidates:replay`, `candidates:diff` (queries/actions) and `investigations:cancel`, `investigations:capture`, `reviews:record` (mutations). Evidence and reviews live in SpacetimeDB; the browser reads them through the same Convex facade (joined by application UUIDs) instead of a second client, so there is one auth boundary.
- Fixture mode: used when `VITE_CONVEX_URL` is absent or `VITE_FORKSAFE_DATA=fixture`. Serves `src/fixtures/demo.json` (synthetic, regenerate with `node scripts/gen-fixtures.mjs`). The header banner and the "Web data" readiness item say fixture. Fixture reviews are stored in this browser's localStorage only, and fixture capture refuses to fake a physics run.

## Readiness

`GET /api/readiness` (Vite dev and preview middleware, `server/readiness.ts`) returns `{ integrations: IntegrationReadiness[] }` from the root `.env`. Missing credentials are reported by name only, unreachable or 404 services are `blocked`, disabled ones `not_implemented`. Secret values never reach the browser.
