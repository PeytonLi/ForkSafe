# Hosted web access control

Convex Auth (`@convex-dev/auth` stable v1, 0.0.96) uses Auth0 for Google sign-in
and the Password provider for existing email accounts. Auth0 holds the Google
connection, so ForkSafe does not register an app in Google Cloud. The browser's
existing Convex React client is wrapped in `ConvexAuthProvider` only in Convex
mode. Fixture mode still uses browser-local fixture behavior. The Account area
offers Continue with Google, email sign-in, invited email sign-up, and sign-out.
Capture, review, and cancel controls require a signed-in account with access.
Email sign-up checks the invite before it creates the account. A new Google
account redeems the same invite after sign-in. Accounts that already existed
keep their access. Session changes remount the app to discard previously
displayed private data. `auth:viewer` confirms the identity on the server; UI
gating is not an authorization boundary.

## Deployment configuration

- `JWT_PRIVATE_KEY`: RS256 PKCS8 signing key, with newlines replaced by spaces.
- `JWKS`: JSON public key set corresponding to that private key.
- `SITE_URL`: where the browser returns after Auth0 finishes Google sign-in.
  The hosted app is `https://giant-jellyfish-684.convex.site`. A local Vite app
  on the same deployment needs `http://localhost:5173` instead; one deployment
  has one `SITE_URL`.
- `CONVEX_SITE_URL`: Convex-provided issuer used in `auth.config.ts`.
- `AUTH_AUTH0_ISSUER`, `AUTH_AUTH0_ID`, and `AUTH_AUTH0_SECRET`: the Auth0
  application. Issuer is `https://<tenant>.us.auth0.com` with no trailing slash.
  The Auth0 callback URL is
  `https://giant-jellyfish-684.convex.site/api/auth/callback/auth0`.
  These values stay on the Convex deployment. They are not `VITE_` variables.
  In Auth0, create a Regular Web Application, turn on the Google social
  connection, and leave **Use Auth0 developer keys** on. That shared Google
  client is what avoids a Google Cloud project. Auth0 shows its own name on the
  Google consent screen, and those keys are for this demo rather than a later
  production launch. Blocking a user in Auth0 stops their next sign-in; a
  session that already exists continues until they sign out.
- `FORKSAFE_INVITE_CODE`: random shared invitation. Missing configuration or an
  incorrect/missing code denies email sign-up and Google invite redemption.
  Comparison uses `constantTimeEqual`. Email sign-in does not require an invite.
  A new Google account is signed in but cannot read private investigations,
  ask about them, or write until `auth:redeemInvite` accepts this code. Eight
  missed guesses in an hour stop further attempts for that account. Accounts created before
  Google sign-in omit that flag and keep their access. Password hashing and
  session management are provided by Convex Auth. Email verification and
  password reset are not enabled. Google reports whether the address is verified.
- `FORKSAFE_PUBLIC_INVESTIGATION_IDS`: comma-separated investigation UUIDs.
- `INTEGRATION_SHARED_SECRET`: existing CLI/integration service-token path.
- `FORKSAFE_DEV_ANONYMOUS_UI`: can grant a write identity only if
  `CONVEX_CLOUD_URL` has hostname exactly `localhost` or `127.0.0.1`.
  Missing/invalid URLs and hosted dev deployments fail closed for writes.

Peyton can retrieve the invite privately from the repository's Convex workspace:

```sh
pnpm --filter @forksafe/convex exec convex env get FORKSAFE_INVITE_CODE
```

Do not paste the invite, passwords, session tokens, or signing key into logs,
screenshots, source control, or browser build environment variables. Rotate the
invite using `convex env set FORKSAFE_INVITE_CODE` to stop further sign-ups with
the old invitation; existing accounts remain valid.

To publish another investigation, inspect it first and append its UUID to the
comma-separated value using `convex env set FORKSAFE_PUBLIC_INVESTIGATION_IDS`.
Publishing exposes the workspace, associated findings, and non-withheld replays.
Current public demos:

- `5a379588-2a94-4943-8496-6ffa1d1511cd` (`demo-seed-v1`, recorded baseline).
- `15c5a86b-cb26-4944-a408-1c8f83d3f92b` (latest recorded hosted demo).

## Server policy

Authenticated identities with access, and valid service tokens, read all investigations.
A Google account with `accessGranted: false` is treated as signed out for private
reads and for capture, cancel, and review.
Anonymous list responses redact private titles/state/metadata, retaining only
the UUID and a restricted placeholder. Workspace, findings, raw investigation
get, and artifact replay enforce public membership or privileged access.
Withheld replays stay forbidden even with a browser identity.

Capture/cancel/review, and the older create/start entrypoints, require a server
identity or service token. Browser reviews use only `convex-auth:<subject>`;
the public validator rejects extra `reviewerIdentity` arguments. Service calls
use `service:integration`; local anonymous writes use `local:anonymous-ui`.
Granted accounts currently have the same access. The invite flag is the only
per-account distinction. There are no tenant, project, reviewer-role, or
per-user ownership restrictions.

## Candidate lane

`convex/candidates.ts` is owned by another lane and was not modified. Both
`candidates:replay` and `candidates:diff` still call the old synchronous
`requireUiAccess`, not the new investigation access helper. That helper now
honors the anonymous flag only on localhost/127.0.0.1 deployments. Hosted
candidate replay/diff are service-token-only, including for public investigations
and signed-in browser users, until the owning lane adopts the async read policy.
Tests verify that the former hosted anonymous bypass is closed.

Other legacy service/runner/Forge endpoints retain their existing separate
authentication policies. Public UUIDs and restricted-list UUIDs are not secrets.
Invite possession grants an account, not a verified email identity. XSS in the
same origin could steal browser-held auth tokens; use trusted assets and rotate
credentials on suspected compromise. Paid execution controls remain server-side;
the hosted smoke test never starts a capture or modifies a real investigation.

## Checks

Default Convex tests cover invite validation, hosted/local identity rules,
browser/service writes, spoofed reviewer rejection, and public/private reads.
Web tests cover signed-out write gating. Hosted contract tests remain opt-in:
`FORKSAFE_LIVE_CONVEX=1 pnpm --filter @forksafe/web exec vitest run src/services/convexClient.contract.test.ts`.
