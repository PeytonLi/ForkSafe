# Forge development notes

## App layout

- `manifest.yml` declares the Jira issue panel, issue action, resolver, static
  icon, `forksafe-backend` remote, and the `forksafe-selfcheck` webtrigger.
- `src/index.ts` exports the resolver handler. `src/handlers.ts` derives issue,
  project, and reviewer identity only from Forge context.
- `src/backend.ts` selects deterministic fixtures or schema-checked Forge
  Remote requests.
- `src/frontend/` contains UI Kit native resources.

## Backend and identity boundary

Forge Remote requests use POST JSON at `/forge/v1/panel`,
`/forge/v1/investigations`, `/forge/v1/review-context`, and
`/forge/v1/reviews`. The requests feature path is
`/forge/v1/requests` (`FORGE_FEATURE_PATHS.requests`) and accepts requests for
more investigation. It is feature-detected: a 404 without a JSON `error` code
means this feature is not available yet; a JSON error response, including a
JSON 404, remains a normal backend error. Only allowlisted JSON error codes
are exposed to the resolver. The implementation validates request/response
data using the shared zod protocol schemas. The backend must independently
verify the Forge Invocation Token, its issuer/audience and `app.id`, and
enforce installation and project authorization before processing a request.

Panel/start handlers take issue key, issue ID, and project key from
`context.extension`; review identity is `atlassian:<context.accountId>`.
Review requests are strict and carry the candidate/evaluation IDs plus the
lowercase SHA-256. The backend re-loads the review context and checks that
exact version before recording a review. A review ID is deterministically
derived from the account ID and `submitKey`, so retrying the same submission
for the same account is idempotent. Do not trust browser-supplied identities
or authorize based on issue data alone.

The `getPanel` resolver strips failed-case IDs from every withheld suite before
returning data to the browser. `getReviewDetails` returns a sanitized review
summary: withheld evaluations contain counts but never case records or
failed-case IDs; failed-case IDs are included only for public evaluations.
The `requestMoreInvestigation` resolver derives the requester from Forge
context and uses the form's stable submit key as the request idempotency key.

The `forksafe-selfcheck` webtrigger has a publicly callable URL. Retrieve the
current development URL with
`forge webtrigger list --functionKey forksafe-selfcheck --site <site>.atlassian.net --product Jira --environment development`.
It calls the panel handler with empty context and makes no backend request.
Its JSON response contains only the app name, resolver names, the fixed
`no_issue_context` result, and backend mode. It does not return issue,
investigation, or user data. Do not add private data to this response.

## Configuration and deployment

The app is registered under Developer Space **Peyton ForkSafe** with ID
`ari:cloud:ecosystem::app/66bb7292-9ddc-4529-aa0f-db7b15fc667a`.

Use an authorized development site. Configure `CONVEX_SITE_URL` with
`node scripts/configure-remote.mjs`, set the Forge variable
`FORKSAFE_BACKEND_MODE=remote`, and build the resolver before deployment:

```sh
pnpm --filter @forksafe/forge build
forge lint
forge deploy -e development --non-interactive
```

The configuration script rejects non-HTTPS URLs and changes only the remote
base URL. Install only into an authorized development site.

The fixture backend is selected unless `FORKSAFE_BACKEND_MODE=remote`; fixture
mode remains visibly labeled in the UI. The app does not use a shared secret
in the client or Forge variables.
