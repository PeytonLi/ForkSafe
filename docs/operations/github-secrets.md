# GitHub Actions secrets for the nightly job

The "Nightly hosted smoke" workflow (`.github/workflows/nightly-hosted-smoke.yml`)
reads the secrets below. Every one is optional: if a secret is missing, that
service shows "skipped, not configured" in the run summary and the job still
passes. Add the ones you want checked every night.

The names are the same as in `.env.example`, so you can copy values from your
`.env.local` or from Devin's saved secrets.

## The list

| Secret name | Used by | Where to get it |
| --- | --- | --- |
| `CONVEX_SITE_URL` | Convex probe | Convex dashboard, project forksafe, dev deployment, Settings, URL & Deploy Key, "HTTP Actions URL". Today: `https://giant-jellyfish-684.convex.site` |
| `CONVEX_URL` | Convex probe (fallback if site URL is absent) | Same page, "Deployment URL" (`https://giant-jellyfish-684.convex.cloud`) |
| `SPACETIMEDB_URI` | SpacetimeDB probe | Not secret. Use `wss://maincloud.spacetimedb.com` |
| `SPACETIMEDB_DATABASE` | SpacetimeDB probe | Not secret. Use `forksafe` |
| `DAYTONA_API_KEY` | Daytona probe and sandbox cleanup | app.daytona.io, Keys |
| `DAYTONA_API_URL` | Daytona (optional) | Leave unset unless you use a non-default endpoint (default `https://app.daytona.io/api`) |
| `FACTORY_API_KEY` | Factory row (presence only, not verified) | app.factory.ai, Settings, API Keys |
| `ELASTICSEARCH_URL` | Elastic probe | Elastic Cloud console, project forksafe, "Elasticsearch endpoint" |
| `ELASTICSEARCH_API_KEY` | Elastic and Kibana Agent Builder probes | Elastic project, Management, API keys |
| `KIBANA_URL` | Kibana Agent Builder probe | Elastic Cloud console, project forksafe, "Kibana endpoint" |
| `KIBANA_API_KEY` | Kibana (optional fallback) | Leave unset; the Elasticsearch key already works for Kibana |
| `ATLASSIAN_SITE_URL` | Jira probe | Your site, `https://amhack.atlassian.net` |
| `ATLASSIAN_EMAIL` | Jira probe | The Atlassian account email that owns the token |
| `ATLASSIAN_API_TOKEN` | Jira probe | id.atlassian.com, Security, API tokens |
| `ATLASSIAN_PROJECT_KEY` | Jira probe | `FS` |

The job masks the email and the URLs in its logs too, and the summary redacts
every value, so nothing above is printed even if a vendor echoes it back.

## Adding a secret, click by click

1. Open https://github.com/PeytonLi/ForkSafe in your browser.
2. Click **Settings** (top bar of the repo, far right). You need admin rights on the repo to see it.
3. In the left sidebar, find **Security**, click **Secrets and variables**, then **Actions**.
4. Stay on the **Secrets** tab and click the green **New repository secret** button.
5. In **Name**, type the exact name from the table, for example `DAYTONA_API_KEY`. Names are case sensitive.
6. In **Secret**, paste the value. No quotes, no spaces or newline at the end.
7. Click **Add secret**.
8. Repeat steps 4 to 7 for each secret you want.

## Checking it worked

1. In the repo, click **Actions**.
2. In the left list, click **Nightly hosted smoke**.
3. Click **Run workflow** (right side), keep the branch as `main`, leave confirm as `no`, and click the green **Run workflow** button.
4. Open the run when it appears, then scroll to the summary. Each service you configured should say **pass**. Services you skipped say **skipped, not configured**.
5. The full JSON result is under **Artifacts** at the bottom of the run page (`hosted-smoke-<run id>`).

If a row says **fail**, see docs/operations/runbook.md section 2.

## Rotating a secret

Same page as above: click the pencil next to the secret name, paste the new
value, click **Update secret**. The next run uses it. See the runbook for the
full rotation order (create new, update everywhere, verify, revoke old).

## Forks and pull requests

The workflow only runs on schedule or by hand, and only in `PeytonLi/ForkSafe`.
Forks never run it, and pull requests never see these secrets.
