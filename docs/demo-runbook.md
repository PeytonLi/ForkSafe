# ForkSafe demo runbook

The reliable demo today is a clearly labelled recorded browser story plus a real
local physics benchmark. You can also show read-only cloud health. Do not present
these three things as one completed hosted repair.

## 1. Preflight

From the repository root, with authorized development credentials injected or
stored in ignored `.env.local`:

```sh
pnpm run doctor --live
pnpm smoke:hosted
pnpm cleanup:sandboxes
```

Read the output before continuing. Blocked rows are warnings unless you use
`doctor --strict`; a failed configured live probe exits 1. Factory remains
`not_verified`. The smoke command is read-only endpoint health, not a Factory
tool call or a Daytona physics run. Cleanup is dry-run unless you add `--yes`.

Have Node 22, pnpm, Python 3.12, uv, both CLIs, the virtual environment and pinned
assets ready. If needed, run `pnpm run setup` before the presentation.
Keep a browser window at <http://localhost:5173> and a separate terminal for
the benchmark. Do not display credentials, headers or raw cloud response bodies.

## 2. Seed checkpoint

```sh
pnpm seed:demo
```

Today this reports `convex/demo.ts not on main yet (pipeline lane)` and exits 2.
That is an honest stop for hosted seeding, not a successful seed. Once the
pipeline lane supplies that module, the command invokes `demo:seed` on the
configured deployment and needs `CONVEX_DEPLOY_KEY`. Check that lane's seed
contract before making a hosted run. Do not repeatedly seed a shared deployment
without understanding its idempotency.

The fixture tour below does not depend on seed data.

## 3. Start the local demo

```sh
VITE_FORKSAFE_DATA=fixture pnpm dev
```

This starts Vite, simulator and evaluator on 5173, 8000 and 8001. It does not
start cloud workers, Convex or SpacetimeDB. The explicit fixture override prevents
a saved hosted URL from silently changing this tour.

Say: “This browser story is recorded fixture data. I'll separately show real
local physics and which cloud endpoints are reachable.”

## 4. Walk the web screens

1. Open <http://localhost:5173>. Show the banner **Showing recorded fixture data,
   not live results** and the readiness strip. Expand the readiness details to
   distinguish the web data source from integration readiness.
2. In **Investigations**, choose **Panda clips divider**. The Capture tab has
   **Baseline replay**, **Captured failure**, and **Scenario editor**.
   Point out seed **1042**, the controller/assets hashes and engine version.
3. Scrub the baseline replay to **4.1 s**, or use **Jump to failure**.
   Say: “This recording shows cube contact with the divider. Its seed and
   controller version make the observation traceable.” Do not say it ran now.
4. Show the **Scenario editor** fields, seed and **Environments (1–10)**.
   If you click **Record baseline run** in fixture mode, it explicitly reports
   that fixture mode cannot run physics. This is useful to show the boundary;
   it is not a live capture button in this tour.
5. Click **Environments**. Show the separate environment tiles and open
   **Experiment timeline** on the first tile. Say: “These are independent
   investigation histories in the fixture, not one agent's unverified summary.”
6. Click **Evidence**. Show findings with environment provenance. Explain that
   an explanation should lead back to the underlying experiment and artifacts.
7. Click **Compare & review**. Select a candidate if needed. Scrub the shared
   replay control to **5 s** and show both original and candidate frame readouts.
   Point out **plan_transit** in the changed functions, the full candidate
   SHA-256, and the recorded public-suite **10/10 passed** result.
   Say: “These are fixture evaluation results; a live candidate must be evaluated
   independently against its exact hash, including withheld cases.”
8. Select **Approve for engineering review**, enter notes in **Notes (optional)**,
   and submit. Show the review history and matching controller hash.
   Say: “This is an engineering review, not permission to deploy a robot.
   In fixture mode it is signed as the fixture reviewer and saved in this browser.”

Optional boundary checks: choose the **fast transit** investigation and click
**Cancel investigation**, accept the confirmation and show the cancellation
pending phase. Choosing **Restricted** shows **Access denied**. Neither action
proves hosted authorization or cancels a real cloud sandbox in fixture mode.

## 5. Jira / Forge checkpoint

There is no Jira panel embedded in the web tabs. The investigation header only
shows a Jira key when one is attached. The native **ForkSafe investigation**
panel and **Start ForkSafe investigation** issue action live in Jira.

Only show the following if the Forge app has actually been built, deployed and
installed into the authorized Jira development site:

1. Open a linked Jira issue and its **ForkSafe investigation** panel.
2. Show the mode label and integration readiness, requirements revision,
   candidate comparison and exact-hash review controls.
3. If it says fixture, say so. Do not submit a remote review or start real work
   unless that is part of the authorized demo plan.

The app code exists, but the checked-in remote URL is a placeholder and ops has
not verified deployment/installation. Remote mode depends on the backend/Forge
lanes completing configuration. Follow [the Forge guide](../apps/forge/README.md).
A successful Jira project probe establishes project access, not this panel.

## 6. Elastic Agent Builder checkpoint

There is no Agent Builder chat screen in the ForkSafe web app. If an authorized
Kibana project has the read-only agent/tools configured and this investigation's
evidence is actually indexed, open **Agent Builder** in Kibana and select that
agent. Ask:

> For investigation <actual investigation UUID>, which experiments show divider
> contact, and what evidence supports the candidate's clearance? Cite docType,
> id, investigationId and sourceVersion for every source.

Use a real indexed ID, not a fixture UUID that was never uploaded. Keep tools
scoped to that investigation. Check returned references against canonical
evidence; an answer with missing/stale/unauthorized citations is not a result to
present as verified. Say: “This is evidence navigation, not an evaluator score.”

Ops verified the agents-list endpoint, not a scoped converse request. If tools,
data or package `KIBANA_API_KEY` configuration are missing, explain the
dependency and skip this portion rather than inventing an answer. See the
[Elastic guide](../packages/integrations/elastic/README.md).

## 7. Run real local physics

In the second terminal:

```sh
pnpm benchmark
```

Expected baseline summary:

```text
[ops] Running simulator baseline fallback (known collision is an expected result)
[ops] Result: completed=false; failureKinds=["forbidden_contact"]
[ops] Wall time: <measured seconds>s
```

Say: “This command ran the baseline controller in MuJoCo now. The known collision
is the expected measured failure; the command succeeded because it produced a
parseable result.” This is a single baseline run, not a measured parallel speedup
or a hosted repair. Crashes and unparseable output exit nonzero.

## 8. Teardown

1. Stop root dev with Ctrl-C; it shuts down all three process groups.
2. End any real ForkSafe work before deleting its sandboxes.
3. Review the dry-run list, then explicitly confirm owned-resource cleanup:

```sh
pnpm cleanup:sandboxes
pnpm cleanup:sandboxes --yes
```

Only exact `forksafe.project=forksafe` resources are eligible, and
`trueforge*` names are excluded. Do not clean up another project's resources.
Local artifacts remain under `var/artifacts`; fixture review storage stays in
the browser. Clear that site's local storage for a fresh fixture review demo.

For failures, use [troubleshooting](troubleshooting.md). For the difference
between code, fixtures and live evidence, use the
[integration matrix](integration-matrix.md).
