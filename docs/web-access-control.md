# Hosted web access control

Convex Auth (`@convex-dev/auth` stable v1, 0.0.96) uses the Password provider.
The browser's existing Convex React client is wrapped in `ConvexAuthProvider`
only in Convex mode. Fixture mode still uses browser-local fixture behavior.
The Account area supports sign-in, invited sign-up, and sign-out. Capture,
review, and cancel controls require sign-in. Session changes remount the app
to discard previously displayed private data. `auth:viewer` confirms the
identity on the server; UI gating is not an authorization boundary.

## Deployment configuration

- `JWT_PRIVATE_KEY`: RS256 PKCS8 signing key, with newlines replaced by spaces.
- `JWKS`: JSON public key set corresponding to that private key.
- `SITE_URL`: `https://giant-jellyfish-684.convex.site`.
- `CONVEX_SITE_URL`: Convex-provided issuer used in `auth.config.ts`.
- `FORKSAFE_INVITE_CODE`: random shared sign-up invitation. Missing configuration
  or an incorrect/missing code denies sign-up. Comparison uses `constantTimeEqual`.
  Sign-in does not require an invite. Password hashing/session management are
  provided by Convex Auth. Email verification and password reset are not enabled.
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

Authenticated identities and valid service tokens read all investigations.
Anonymous list responses redact private titles/state/metadata, retaining only
the UUID and a restricted placeholder. Workspace, findings, raw investigation
get, and artifact replay enforce public membership or privileged access.
Withheld replays stay forbidden even with a browser identity.

Capture/cancel/review, and the older create/start entrypoints, require a server
identity or service token. Browser reviews use only `convex-auth:<subject>`;
the public validator rejects extra `reviewerIdentity` arguments. Service calls
use `service:integration`; local anonymous writes use `local:anonymous-ui`.
All authenticated users currently have the same access; there are no tenant,
project, reviewer-role, approval, or per-user ownership restrictions.

## Known uncovered surface: candidate lane

`convex/candidates.ts` is owned by another lane and was not modified. Both
`candidates:replay` and `candidates:diff` still call the old synchronous
`requireUiAccess`, not the new investigation access helper. With hosted
`FORKSAFE_DEV_ANONYMOUS_UI=true`, anonymous callers knowing a private candidate
UUID can access its replay/source diff, without checking public investigation
membership. The regression test demonstrates both bypasses with seeded
private data. These routes also do not recognize browser auth identities when
the legacy flag is disabled. The owning lane must adopt the async read policy.
This is not a complete private-data security boundary until that is fixed.

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
