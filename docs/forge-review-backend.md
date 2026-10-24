# Forge review backend (#18 compatibility)

`convex/forgeProtocolExt.ts` mirrors PR #18's optional protocol extensions until
that branch merges. Old clients still parse panel/review-context responses.
All missing-investigation responses are JSON 404 with
`error: "investigation_not_found"`, not an untyped feature-unavailable 404.
The Forge client distinguishes those errors from an unimplemented requests route.

Panels include the latest evaluation for each public/withheld suite. Withheld
summaries include counts but never `failedCaseIds`. Findings are the newest 25
Convex-projected findings, with up to 10 evidence citations each. Canonical
candidate/evaluation/review data still comes from SpacetimeDB.

Set `FORKSAFE_WEB_URL` to an HTTPS URL without credentials. Web links use the
web app's hash route: `#/investigations/<uuid>/capture`.

There is no evidence-pack artifact kind in contracts. A pack is a `report`
artifact with the additive `evidencePack: true` marker. Internal producers can
set this via `internal.artifacts.insertCloudArtifact`. Unmarked, withheld,
revoked, local-filesystem, or missing-storage artifacts do not create links.
For the newest eligible pack, `ctx.storage.getUrl` supplies the HTTPS download
URL used by panel links and review context. These are bearer storage URLs:
do not publish packs containing withheld cases or other sensitive material.
Convex storage URLs are not application-expiring URLs; deleting storage is
required to invalidate an already issued URL. Revocation prevents future issuance.
There is currently no evidence-pack producer, so links are normally omitted.

## More investigation

POST `/forge/v1/requests` uses the same FIT verification, installation allowlist,
project/issue authorization, and token-derived identity as reviews. `requestedBy`
must equal `atlassian:<FIT principal>`; it is never accepted as identity evidence.
Bodies use #18's strict schema: trimmed nonempty note up to 500 characters,
UUID idempotency key, and optional integer `extraEnvironments` from **1–3**.
#18 does not permit zero. Omitting the count defaults to **one** extra environment.

An atomic internal mutation stores the request/result in `forgeRequests` and
creates an `admitted` investigation linked through `parentInvestigationId`,
copying the parent's baseline and budget. Its requested environment count is the
requested extra count. The request stores the follow-up investigation ID even
though #18's response only exposes the request ID. Same key and normalized
payload returns the stored response; changes to payload/identity/installation
return JSON 409 `request_conflict`.

This is admission only: no environments, jobs, reservations, workflows, capture,
or Daytona work are started. Resumption/execution is deliberately left to a
subsequent operator/lifecycle action; this endpoint does not schedule it.
