# Daytona network access

ForkSafe runs the Factory runner inside a Daytona sandbox. Tier 1 and Tier 2 organizations have an organization-wide firewall that only allows essential services. The Factory hosts `api.factory.ai` and `app.factory.ai` are not on that list, so Droid cannot reach them from the runner. A sandbox-level setting cannot override the organization firewall on those tiers.

There are three ways to fix this:

1. **Upgrade the Daytona organization to Tier 3.** Tier 3 and Tier 4 allow per-sandbox network settings.
2. **Ask Daytona support to allowlist `api.factory.ai` and `app.factory.ai`** for the organization.
3. **Run the Factory runner on an external host** with outbound access to those services instead of inside Daytona.

## Check connectivity

Run `pnpm daytona:egress-probe` to create one small, short-lived sandbox and check `api.factory.ai`, `app.factory.ai`, `giant-jellyfish-684.convex.site`, SpacetimeDB Maincloud, and PyPI. The command prints each host's reachability and HTTP status, then deletes the probe sandbox. It requires `DAYTONA_API_KEY` and a usable runner image environment. Use it again after changing the organization tier, firewall, or runner settings.

## Runner network settings

Tier 3 and Tier 4 can apply a network policy to an individual sandbox. The typed Daytona policy supports a domain allowlist, blocking all network traffic, or routing HTTP(S) through a proxy. Daytona treats `domainAllowList` and `networkBlockAll` as mutually exclusive. A proxy can be combined with a domain allowlist for network-layer enforcement.

Set these optional environment variables to apply the settings to runner sandboxes:

```sh
DAYTONA_RUNNER_DOMAIN_ALLOWLIST=api.factory.ai,app.factory.ai
DAYTONA_RUNNER_OUTBOUND_PROXY_URL=https://proxy.example
```

The allowlist is a comma-separated list of domains; include every host the runner needs. The proxy URL is optional and may contain credentials. Keep it private: the adapter does not include proxy URL user information in logs or errors. The SDK applies the proxy at sandbox creation through the standard `HTTP_PROXY` and `HTTPS_PROXY` environment variables.
