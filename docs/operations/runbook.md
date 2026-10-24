# ForkSafe on-call runbook

This is the page to open when something looks wrong. It is written for a tired
person at 2 a.m.: short steps, plain words, no guessing.

Golden rules:

- Never paste a secret value into chat, a ticket, a log or a commit. Names are fine, values are not.
- Never present fixture data as live. If a service is down, say so.
- Never republish SpacetimeDB with `--delete-data`. Maincloud `forksafe` holds real data.
- Only one person deploys Convex at a time. A deploy replaces every function.

## 1. Reading the readiness pill

The strip at the top of the web app shows one pill per integration, plus a
"Web data" pill that says where the page itself is reading from. Click
"Details" to see the reason behind each pill.

| Pill says | What it means | What to do |
| --- | --- | --- |
| live | Credentials are set and the service answered. Real results. | Nothing. |
| local | Running against a local stand-in on this machine (local Python services, local SpacetimeDB). Real behaviour, not hosted. | Fine for development. For the hosted product switch the `*_MODE` variable to `cloud`. |
| fixture | Showing recorded demo data. Nothing real is happening. | Set `<SERVICE>_MODE=cloud` and add the credentials. Never demo this as live. |
| blocked | The service is meant to be live but a required credential or URL is missing, or the probe failed. Work that needs it will refuse to run (it fails closed). | Open Details; it names the missing variable. Add it (section 3), then re-run the smoke check. |
| not implemented / disabled | The integration is switched off or not built yet. | Expected. Not an incident. |
| Readiness unavailable (CODE) | The web app could not reach Convex to ask. | Check Convex first (section 4, step 2). |

The same check from a terminal: `pnpm run doctor --live` (local) or
`pnpm smoke:hosted` (hosted). The nightly GitHub job "Nightly hosted smoke"
runs it every day at 09:00 UTC and writes a table to the run summary.

In the nightly table:

- **pass**: the service answered with a success code.
- **fail**: it was configured and did not answer properly. This fails the job. Investigate.
- **skipped, not configured**: the GitHub secret is missing. The job still passes. Add the secret if you want it checked (see github-secrets.md).
- **not_verified**: the key is present but there is no safe read-only call to test it. Today that is Factory. Check the Factory dashboard by hand if agents start failing.

## 2. What each blocked state usually means

| Service | Usual cause when blocked or failing | First check |
| --- | --- | --- |
| Convex | `CONVEX_SITE_URL`/`CONVEX_URL` missing, or the deployment is paused. | Open https://giant-jellyfish-684.convex.site/health. It should return 200. |
| SpacetimeDB | `SPACETIMEDB_URI` or `SPACETIMEDB_DATABASE` missing, or the module failed to publish. | `spacetime logs --server maincloud forksafe`. |
| Daytona | `DAYTONA_API_KEY` missing, revoked, or the org hit its 5-sandbox cap. | `pnpm cleanup:sandboxes` (dry run) to see what is running. |
| Factory | `FACTORY_API_KEY` missing or out of credit. | Factory dashboard usage page. |
| Elastic | `ELASTICSEARCH_URL`/`ELASTICSEARCH_API_KEY` missing, key expired, project paused. | Elastic Cloud console, project forksafe. |
| Kibana Agent Builder | `KIBANA_URL` missing, or the ES key lost Kibana privileges. | `pnpm --filter @forksafe/elastic agent:ensure`. |
| Jira / Confluence | Site URL, email, token or project key missing; token expired (Atlassian tokens expire). | Log in to amhack.atlassian.net and open project FS. |
| Simulator / Evaluator | Python services not running, or the Daytona execution snapshot is missing. | `pnpm run doctor --live`. |

## 3. Rotating credentials

General pattern for every credential:

1. Create the new credential at the vendor (steps below). Do not revoke the old one yet.
2. Update every place that holds it: your `.env.local`, the hosted Convex env (if listed), the Devin secret, and the GitHub Actions secret of the same name.
3. Run `pnpm smoke:hosted` locally, or start the "Nightly hosted smoke" workflow by hand (Actions tab, Run workflow). Every row you rotated should say pass.
4. Revoke the old credential at the vendor.
5. Run the smoke check once more to prove nothing still used the old one.

Set a hosted Convex env value without it entering shell history:

```sh
read -rs VALUE && npx convex env set NAME "$VALUE" && unset VALUE
```

(`CONVEX_DEPLOY_KEY` must be in your environment for `npx convex`.)

### Factory (`FACTORY_API_KEY`)

1. Go to https://app.factory.ai, open Settings, then API Keys.
2. Create a new key named `forksafe-<date>`.
3. Update `.env.local`, the Devin secret, the GitHub secret, and `npx convex env set FACTORY_API_KEY` if the hosted runner reads it from Convex.
4. Smoke check, then delete the old key in the same page.

### Daytona (`DAYTONA_API_KEY`)

1. Go to https://app.daytona.io, open Keys (API Keys).
2. Create a key with sandbox read/write permissions.
3. Update `.env.local`, the Devin secret, the GitHub secret, and the hosted Convex `DAYTONA_API_KEY`.
4. Smoke check (Daytona row should pass), then delete the old key.

### Convex deploy key (`CONVEX_DEPLOY_KEY`)

1. Go to https://dashboard.convex.dev, open project forksafe, choose the dev deployment.
2. Settings, then Deploy Keys (or "Generate Development Deploy Key").
3. Generate a new key and update the Devin secret and anywhere else it is stored (`.env.local`). It is not used by the nightly job.
4. Run `npx convex env list` with the new key to prove it works, then revoke the old key on the same page.

### SpacetimeDB bridge secret (`FORKSAFE_BRIDGE_SECRET`)

This secret lets Convex register as the trusted bridge with the Maincloud module. Both sides must match.

1. Generate a new value: `openssl rand -hex 32` (do it in a terminal you trust; do not echo it anywhere else).
2. Update the module's env without touching data (needs the Maincloud CLI login, which lives on the lead VM):
   ```sh
   read -rs FORKSAFE_BRIDGE_SECRET && export FORKSAFE_BRIDGE_SECRET
   spacetime publish --server maincloud -y --module-path packages/spacetimedb --env-only forksafe
   ```
3. Set the same value on Convex: `npx convex env set FORKSAFE_BRIDGE_SECRET "$FORKSAFE_BRIDGE_SECRET"`, then `unset FORKSAFE_BRIDGE_SECRET`.
4. Start a small run and confirm the bridge registers (Convex logs show no "bridge rejected" errors). See docs/publish-spacetimedb.md.

### Elastic (`ELASTICSEARCH_API_KEY`)

1. Open the Elastic Cloud console, open the forksafe project, then Management, then API keys.
2. Create a key with read/write on the `forksafe-*` indices and Kibana Agent Builder access.
3. Update `.env.local`, the Devin secret, the GitHub secret, and the hosted Convex value if set there.
4. Smoke check: both the Elastic row and the Kibana Agent Builder row must pass. Then invalidate the old key.

### Atlassian (`ATLASSIAN_API_TOKEN`)

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens.
2. Click "Create API token", name it `forksafe-<date>`, choose an expiry, copy it.
3. Update `.env.local`, the Devin secret, the GitHub secret, and Forge variables if the Forge app uses it (`forge variables set`, then `forge deploy` so it takes effect).
4. Smoke check (Atlassian/Jira row), then revoke the old token on the same page.

## 4. Republishing SpacetimeDB safely

1. Only republish from a machine that is logged in to Maincloud (`spacetime login show`).
2. Make sure your module change is additive: new tables or reducers only. Never change or remove existing columns.
3. Prove it locally first: `pnpm --filter @forksafe/spacetimedb test:migration`. It publishes main's module and then your branch onto one local database.
4. Publish with the bridge secret loaded, and **never** add `--delete-data`:
   ```sh
   spacetime publish --server maincloud -y --module-path packages/spacetimedb forksafe
   ```
5. If publish refuses because of a schema conflict, stop. Do not "fix" it with `--delete-data`. Make the change additive instead.
6. Check `spacetime logs --server maincloud forksafe` and run the smoke check.

## 5. Cleaning up sandboxes

ForkSafe sandboxes carry the label `forksafe.project=forksafe`. Anything named `trueforge*` belongs to another project and is never touched.

1. See what exists (safe, deletes nothing): `pnpm cleanup:sandboxes`.
2. Make sure no run is in progress. The cleanup deletes every ForkSafe-labelled sandbox, including ones a live run is using.
3. Delete: `pnpm cleanup:sandboxes --yes`.
4. From GitHub: Actions, "Nightly hosted smoke", Run workflow, type `yes` in the confirm box. Anything else is a dry run. The scheduled nightly run is always a dry run.
5. Daytona's list can show a deleted sandbox as started for a minute. Wait and list again before deciding cleanup failed.

## 6. Incident checklist

1. **Look.** Open the web app readiness strip and the latest "Nightly hosted smoke" run summary. Which rows are not pass?
2. **Scope.** Is it one service or all of them? All of them usually means Convex or your network.
3. **Stop the bleeding.** If agents are misbehaving or spending money, cancel the active runs in the app and run sandbox cleanup (section 5).
4. **Check credentials.** Missing or expired? Rotate (section 3).
5. **Check the vendor status page** (Convex, Daytona, Factory, Elastic, Atlassian, SpacetimeDB).
6. **Be honest in the product.** If a service stays down, leave it blocked. Do not switch it to fixture to make the screen look healthy during a demo without saying so.
7. **Verify the fix** with `pnpm smoke:hosted` or a manual run of the nightly workflow.
8. **Write it down.** What broke, how you noticed, what fixed it, and what would have caught it sooner. Add new lessons to docs/troubleshooting.md.
