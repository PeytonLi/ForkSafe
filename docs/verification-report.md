# Verification report

Run on 2026-10-24 (UTC) on `main` at commit `c0dc558`, on a Linux VM with
Node 22.23.4, pnpm 10.34.8 and Python 3.12 (uv). No code was changed for this run.

## Results

| Check | Command | Started (UTC) | Result |
| --- | --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | 17:58 | pass |
| Type check | `pnpm typecheck` | 17:58 | pass, exit 0 |
| Workspace tests | `pnpm -r --if-present test` | 17:58:19 | pass, exit 0: **472 passed, 3 skipped** across 12 packages |
| Python tests | `.venv/bin/pytest -q` (after `uv sync` and `node scripts/fetch-assets.mjs`) | 17:59:35 | pass, exit 0: **118 passed**, 1 warning, 269.6 s |
| Playwright fixture tests | `pnpm test:e2e` (desktop and mobile) | 18:04:11 | pass, exit 0: **20 passed**, 25.5 s |
| Build | `pnpm build` | 18:04:52 | pass, exit 0 |
| Lint | `pnpm lint` | after build | exit 0, but no package defines `lint`, so nothing was checked |
| Integration tests | `INTEGRATION_LIVE=0 pnpm test:integration` | 18:04:57 | pass, exit 0: **44 passed, 4 skipped** (cloud tests skip without keys) |
| Local dev in fixture mode | `VITE_FORKSAFE_DATA=fixture pnpm dev` | 18:05 | web `:5173`, simulator `:8000/health`, evaluator `:8001/health` all returned 200; log says fixture mode |
| Doctor, no keys | `pnpm run doctor` | 18:00 | exit 0; every cloud row blocked with the missing names, artifacts local |
| Hosted smoke | `pnpm smoke:hosted` with only `CONVEX_SITE_URL` and `DAYTONA_API_KEY` | 18:05 | exit 0; Convex 200, Daytona 200, others blocked because their settings weren't in this shell |
| Sandbox cleanup | `pnpm cleanup:sandboxes` (dry run) | 18:05 | 0 ForkSafe sandboxes |
| Benchmark | `pnpm benchmark` | 18:05:55 | exit 0 in 19.0 s: real MuJoCo run of the original (unfixed) controller on 10 cases; 1 passed (`nominal`), 9 failed with `forbidden_contact`. This is the expected result: it reproduces the baseline failure |

Workspace test counts by package:

| contracts | artifacts | agents | web | atlassian | daytona | spacetimedb | elastic | evidence-pack | forge | runner | convex |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9 | 1 | 28 | 29 (+3 skipped) | 28 | 8 | 49 | 65 | 46 | 20 | 21 | 168 |

## Hosted app checks (read-only)

On 2026-10-24 around 18:00 UTC, `https://giant-jellyfish-684.convex.site/health`
and `/api/readiness` returned 200. Readiness reported Convex, SpacetimeDB,
Daytona, Elastic, Elastic Agent Builder and Jira as live and probed; Factory as
live but not probed; Confluence, simulator and evaluator as not implemented.
Jira `FS-3` and `FS-4` were readable (both To Do). These are health checks, not
a new investigation.

## Not run

- `pnpm seed:demo`: starts a real hosted capture in Daytona; not run from a docs lane.
- `pnpm deploy:web`: deploys the shared hosted app; only the pipeline lane deploys.
- `pnpm daytona:prepare` and `pnpm daytona:egress-probe`: create Daytona sandboxes or snapshots; see #19 and #22 for their recorded results.
- `pnpm release:check`: runs the same steps as above in one go; the steps were run individually instead.
- `pnpm run doctor --live` with every key: not run; the readiness endpoint above covers the hosted view.

## Failures

None of the checks that ran failed.
