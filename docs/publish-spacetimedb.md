# Publish the ForkSafe SpacetimeDB module

Use the same SpacetimeDB CLI version as the module toolchain (2.13.x). The module is published under the `forksafe` database name on Maincloud. Load the bridge secret from the deployment secret manager (or Convex environment) into `FORKSAFE_BRIDGE_SECRET` without putting its value in shell history. Do not use `--delete-data` when publishing an existing database.

Before publishing, verify additive migration behavior against a local persistent-data server, check the committed TypeScript bindings, and build the module:

```sh
pnpm --filter @forksafe/spacetimedb test:migration
pnpm --filter @forksafe/spacetimedb check:bindings
spacetime build --module-path packages/spacetimedb
```

The migration check publishes the old module from `origin/main`, writes fixture rows, and publishes the working-tree module to the same local database without data deletion.

## Initial publish

```sh
spacetime login
FORKSAFE_BRIDGE_SECRET="${FORKSAFE_BRIDGE_SECRET:?Set this from the deployment secret manager}" spacetime publish --server maincloud -y --module-path packages/spacetimedb forksafe
```

The module reads `FORKSAFE_BRIDGE_SECRET` from the SpacetimeDB module environment. Keep it in the deployment secret manager; do not put it in source control, a client bundle, or a shell history entry in managed environments.

## Rotate the bridge secret

Set the new secret in the deployment secret manager, then update only the module environment:

```sh
FORKSAFE_BRIDGE_SECRET="${FORKSAFE_BRIDGE_SECRET:?Set this from the deployment secret manager}" spacetime publish --server maincloud -y --module-path packages/spacetimedb --env-only forksafe
```

After rotation, verify that the bridge uses the new secret to register. Do not republish with a data-deletion flag.

## Configure the Convex bridge

Set the same secret in the Convex deployment environment:

```sh
npx convex env set FORKSAFE_BRIDGE_SECRET "$FORKSAFE_BRIDGE_SECRET"
```

Configure the bridge with the production URI and database identity using the deployment's secret/configuration facility:

```sh
npx convex env set SPACETIMEDB_URI "wss://maincloud.spacetimedb.com"
npx convex env set SPACETIMEDB_DATABASE "forksafe"
```

Do not expose the bridge secret through public/client environment variables.

## Generate bindings and verify publication

```sh
pnpm --filter @forksafe/spacetimedb generate
pnpm --filter @forksafe/spacetimedb check:bindings
spacetime describe --server maincloud forksafe --json
spacetime logs --server maincloud forksafe
```

Bindings are committed so package typechecking does not require the SpacetimeDB CLI when generated bindings are already present. After changing the schema, regenerate and check them before committing. Never use `--delete-data` to resolve a schema migration or publication error; stop and investigate the incompatible change instead.

SpacetimeDB 2.13 does not expose the module's anonymous views as SQL relations or generated TypeScript tables. Use the subscribed base tables and the client live/revoked decoders for those projections.

Use the generated binding package and:

```ts
connectForkSafe({
  uri: process.env.SPACETIMEDB_URI!,
  database: process.env.SPACETIMEDB_DATABASE!,
  token: process.env.SPACETIMEDB_TOKEN,
});
```

The live readiness state is valid only after the client connects successfully. A configured URI or successful module publish alone is not proof of a live integration.
