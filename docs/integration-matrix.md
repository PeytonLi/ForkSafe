# What is live today

Last checked: 2026-10-24 (UTC), on `main` at `c0dc558`.

This page says, for each outside service, whether ForkSafe really uses it right
now. It separates four things that are easy to mix up:

1. **Fixture**: a recorded story in the browser. No cloud, no physics.
2. **Local physics**: `pnpm benchmark` runs real MuJoCo on your machine.
3. **Health checks**: `/health`, `/api/readiness`, `pnpm run doctor --live` and
   `pnpm smoke:hosted` only prove a service answered a read-only call.
4. **A live run**: a real investigation that went through Daytona, Factory,
   SpacetimeDB and the protected evaluator. Two of these are recorded below.

## What the modes mean

| Mode | Meaning |
| --- | --- |
| live | Used for real, with a successful run or probe as evidence |
| configured | Set up, but not yet proven by a real call |
| blocked | Something it needs is missing or unreachable |
| fixture | Recorded or in-memory behavior, never a cloud result |
| not implemented | The feature is off or not built |

Readiness may also say `not_verified`; that is a probe result, not a mode.

## Integration by integration

| Integration | Mode | Evidence | Limits |
| --- | --- | --- | --- |
| Convex (lifecycle, jobs, web hosting) | live | Hosted at `giant-jellyfish-684`. `/health` and `/api/readiness` returned 200 on 2026-10-24. Both live runs below were driven by it (#19, #20, #21). | Only the pipeline lane deploys. Of the #23 web functions, only `web/health:pipeline` is deployed right now; `web/ask` and `web/timeline` are not, so those hosted panels can't load yet. |
| SpacetimeDB Maincloud `forksafe` (evidence) | live | Readiness probe live. Runs wrote grants, experiments, findings, `finding_use`, candidates, evaluations and a review (#16, #19, #21). | One withheld evaluation (`40da69d0...`) was not committed because Maincloud returned HTTP 530 during the run (#21 round 6). Lane VMs can't publish the module; Peyton republishes. |
| Daytona (physics and evaluator sandboxes) | live | Baseline captures, experiments and every protected evaluation ran in `forksafe-exec-v3` sandboxes (#13, #19, #21). Readiness probe live. | Org cap of 5 active sandboxes. On this org's Tier 1/2, sandboxes **cannot reach** `api.factory.ai`, `app.factory.ai` or `maincloud.spacetimedb.com` (HTTP 000); Convex and PyPI are reachable (#22). |
| Trusted runner | live, external host | `RUNNER_LAUNCH_MODE=external` is set on the hosted deployment. The runner drives Factory from outside Daytona because of the egress block (#19, #22). | The runner sandbox path inside Daytona exists but can't reach Factory or Maincloud on this tier. |
| Factory Droid (agents) | live in runs, not probed by readiness | Real sessions in both runs, e.g. `3f12ef04-3d4f-4df9-9baa-8b1cdecfe9c0` and `630a2dd7-f45d-4ea9-9b8c-bd3e271ce790` (#21). Readiness says `configured_not_probed`. | Listing models is not proof: an earlier ops check got 60 models back with an intentionally invalid key. There is no cheap read-only probe. |
| Protected evaluator and signed manifests | live in runs | Ed25519-signed `forksafe.signed_evaluation_manifest.v1` documents, key `ed25519:5438c13759a10ad5`, verified by Convex before scoring (#13, #21). | Readiness still lists simulator and evaluator as `not_implemented`, because it has no probe for them. Trust the run evidence, not that label. |
| Elastic (search) | live, retrieval only | Readiness probe live. Index counts on 2026-10-24: run `195d5a1f...` has 36 experiments, 2 candidates, 4 evaluations, 0 findings; run `fbdc8b1c...` has 2 findings, 2 evidence, 2 candidates, 3 evaluations, 0 experiments (#11, #15, #21). | Never decides a score. Coverage differs per run (see counts). |
| Kibana Agent Builder ("Why did this fail?") | configured | Readiness probe live (agents list answers). Code merged in #15 and #23. | `KIBANA_API_KEY` is not set on the hosted deployment and `web/ask` is not deployed, so the hosted panel is not proven. Answers never affect scores. |
| Jira (project `FS`) | live, review projection | Issues `FS-3` (run `195d5a1f...`) and `FS-4` (run `fbdc8b1c...`) exist, both in To Do on 2026-10-24 (#11, #21). | FS-3 stayed in To Do even though the run was approved; status names are project-specific. |
| Forge review panel | configured | App `66bb7292-9ddc-4529-aa0f-db7b15fc667a` installed on the dev site (installation `3c0775f6-4d23-4a64-b3bb-d32c0f084a66`). Convex `/forge/v1/*` routes answer 401 without a token (#11, #18, #20). | A real Forge Invocation Token (FIT) from inside Jira has not been used yet, so live review context and submitting a review from Forge are not verified. |
| Confluence (requirements page) | configured | Page `327681` in space `TWC` was created and read in #11. | Readiness reports `not_implemented`; not separately probed. |
| Web app | live | Served from Convex static hosting; Auth0 Google sign-in plus the shared invite; public list holds two investigation IDs (#20). | The two live runs below are not on the public list. Fixture mode stays available with `VITE_FORKSAFE_DATA=fixture`. |
| Artifacts | live in runs | Replay and log artifacts were stored with the runs (#21). | Local mode writes to `./var/artifacts`. |
| Telemetry (OpenTelemetry) | not implemented on main | Pending in PR #24. | |
| Chaos harness | not implemented on main | Pending in PR #25. | |

## The two live runs

**Run `195d5a1f-aea3-4f10-af1a-c428fffffca3`** (round 5, #21). State now: completed.

- Two candidates: `32fb6782-61fa-4f95-bf06-01d71bf638d3` and `2c0c7020-2e01-4d30-8a6c-71fd63253a23`.
- Signed evaluations: public 10/10 for both (`996f66d2-b7df-4065-abb2-c1bf942340c4`, `4f479c7f-830f-4a77-8619-7b7cfe9bb517`), withheld 8/8 for both (`8ad96f43-6935-4278-9fa3-8dddca52532d`, `fcd01970-e7bf-4ad8-b380-f9a2b8739a13`).
- Human review `0f8ede3a-d6bb-4aa5-9f1a-623395617613`: approved, bound to the controller SHA-256 of candidate `32fb6782...`.
- Jira `FS-3`. No findings were recorded in this run.

**Run `fbdc8b1c-8970-4b7b-930f-6b917270a1b7`** (round 6, #21). State now: awaiting review.

- Environments `f469945a-109b-4312-a964-534f33b54a01` and `9163e6c8-381f-4745-8210-30366ed7ccc0`.
- Findings `b931ddf4-0b72-4875-933a-33b1dd76de82` and `57ad68df-46ea-4ae2-ac8e-6a4703ff711f`.
- Cross-environment `finding_use` rows `77bd1668-4a77-4161-8e9a-b2ae8896045d` and `8ea4d36e-0f92-47bc-8d31-f3633dde6e81`.
- Candidates `34bb3e70-108f-4fe2-9341-9482bcfc43fa` and `3c3b9bc9-a866-47c5-a142-476d0a54c436`; public evaluations `a1ed438a-3be0-4cf3-acba-fd973c3f3586` and `f7499fb8-3b59-4c07-a2a8-7087b6b33988` both 10/10.
- Withheld evaluations `467606ff-830b-4137-976d-7b73c6cb3cbf` passed; `40da69d0-ba24-4c21-8230-7389781a4356` passed in Convex but did not reach SpacetimeDB (Maincloud HTTP 530).
- Jira `FS-4`. No review submitted yet.

## Pull requests

- Merged into `main`: #9 to #23. (#20 convex-web and #23 web-stretch merged on 2026-10-24.)
- Still open, **not done**: #24 (OpenTelemetry) and #25 (chaos harness).

## Checks you can repeat

```sh
pnpm run doctor          # which settings are missing
pnpm run doctor --live   # read-only cloud checks
pnpm smoke:hosted        # read-only check of the hosted app
pnpm daytona:egress-probe   # what a Daytona sandbox can reach
```

A green result means the service answered at that moment. It does not mean a
full investigation completed. See also [architecture](architecture.md) and the
[on-call runbook](operations/runbook.md).
