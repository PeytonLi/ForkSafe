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
and all required checks passed. Do not treat a fixture review as production
approval.

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
