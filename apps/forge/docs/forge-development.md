# Forge development notes

## App layout

- `manifest.yml` declares the Jira issue panel, issue action, resolver, static
  icon, and `forksafe-backend` remote.
- `src/index.ts` exports the resolver handler. `src/handlers.ts` derives issue,
  project, and reviewer identity only from Forge context.
- `src/backend.ts` selects deterministic fixtures or schema-checked Forge
  Remote requests.
- `src/frontend/` contains UI Kit native resources.

## Backend and identity boundary

Forge Remote requests use POST JSON at `/forge/v1/panel`,
`/forge/v1/investigations`, `/forge/v1/review-context`, and
`/forge/v1/reviews`. The implementation validates request/response data using
the shared zod protocol schemas. Non-success remote responses expose only the
HTTP status. The backend must independently verify the Forge Invocation Token,
its issuer/audience and `app.id`, and enforce installation and project
authorization before processing a request.

Panel/start handlers take issue key, issue ID, and project key from
`context.extension`; review identity is `atlassian:<context.accountId>`.
Review requests are strict and carry the candidate/evaluation IDs plus the
lowercase SHA-256. The backend re-loads the review context and checks that
exact version before recording a review. Do not trust browser-supplied
identities or authorize based on issue data alone.

## Configuration and deployment

Use an authorized development site. Register the app once, configure
`CONVEX_SITE_URL` with `node scripts/configure-remote.mjs`, set the Forge
variable `FORKSAFE_BACKEND_MODE=remote`, then deploy and install with the
development environment. The configuration script rejects non-HTTPS URLs and
changes only the remote base URL. `forge lint` validates the manifest before
deploying.

The fixture backend is selected unless `FORKSAFE_BACKEND_MODE=remote`; fixture
mode remains visibly labeled in the UI. The app does not use a shared secret
in the client or Forge variables.
