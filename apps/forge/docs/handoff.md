# Atlassian handoff

## Development site
Register and install the app only in an authorized non-production Jira site.
Use `forge lint` before deployment. Replace the placeholder remote URL with
the Convex HTTP endpoint using `CONVEX_SITE_URL` and
`node scripts/configure-remote.mjs`; this script changes only the declared
`forksafe-backend` URL and requires HTTPS. Set
`FORKSAFE_BACKEND_MODE=remote` in the Forge development environment only after
the backend endpoint is ready. The fixture backend remains the default and is
explicitly labeled in the issue panel.

## Remote backend
The Forge Remote endpoint contract is POST JSON using the shared schemas in
`@forksafe/integrations-atlassian`:

- `/forge/v1/panel` returns issue-scoped readiness, investigation progress,
  candidate evaluations, requirements revision, and exact candidate hashes.
- `/forge/v1/investigations` starts work using the issue, issue ID, and project
  key derived by the Forge resolver.
- `/forge/v1/review-context` reloads the authoritative investigation,
  candidate, and evaluation before a review is accepted.
- `/forge/v1/reviews` records the validated review.
- `/forge/v1/requests` accepts more-investigation requests. This is a separate
  feature path (`FORGE_FEATURE_PATHS.requests`), not part of the existing
  `FORGE_BACKEND_PATHS` route set. The Forge backend treats a 404 without a
  JSON `error` code as feature-unavailable; a JSON 404 remains an ordinary
  not-found response.

The registered resolvers are `getPanel`, `startInvestigation`,
`submitReview`, `getReviewDetails`, and `requestMoreInvestigation`.

The backend must validate Forge Invocation Tokens with the app audience and
issuer, verify `app.id`, resolve the installation and project authorization,
and reject context that does not match the caller's installation. Never trust
issue, project, or reviewer identifiers supplied by the browser. Configure
project-specific workflow transition names on the backend; the Jira client
does not assume a universal workflow.

## Evidence and human review
Confluence requirements are tied to the selected page ID and revision number.
Checked requirements are shown separately from human-review guidance, and
the original wording stays attached to each extracted item. Reviews bind the
reviewer, investigation, candidate, evaluation, and lowercase SHA-256 of the
exact controller artifact. The resolver reloads this evidence immediately
before recording; an approval is rejected unless the candidate is evaluated
and all required checks passed. A review ID is derived deterministically from
the authenticated account ID and `submitKey`, allowing the same submission
to be retried without creating a second review. Do not treat a fixture review
as production approval.

The panel strips withheld-suite failed-case IDs before returning data.
`getReviewDetails` returns only a sanitized evaluation summary; withheld
evaluations contain counts only, while failed-case IDs may be returned only
for public evaluations. Raw withheld case records are never sent to the
browser.

The `forksafe-selfcheck` webtrigger has a publicly callable URL. Obtain its
current development URL with
`forge webtrigger list --functionKey forksafe-selfcheck --site <site>.atlassian.net --product Jira --environment development`.
It invokes `getPanel` with empty context without calling the backend and
returns only the app name, resolver names, the fixed `no_issue_context`
result, and backend mode. It returns no issue, investigation, or user data.

## Fixture boundary
Jira, Confluence, panel, and review-context fixtures are deterministic local
examples. They are not records from a live tenant and do not create Jira
issues, comments, links, transitions, or reviews remotely. Keep fixture data
clearly labeled and free of real user details or credentials.

## Verification
From the repository root, run:

```sh
pnpm typecheck
pnpm --filter @forksafe/integrations-atlassian test
pnpm --filter @forksafe/forge test
```

From `apps/forge`, run `forge lint`. Do not run `forge register`, deploy, or
install against a site without explicit authorization.
