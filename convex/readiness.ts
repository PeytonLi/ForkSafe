import { IntegrationReadiness } from "@forksafe/contracts";
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { spacetimeConfig } from "./lib/spacetime.js";

type Entry = IntegrationReadiness & { probed: boolean };
export const CACHE_MS = 60_000;

export async function probeIntegrations(env: Record<string, string | undefined> = process.env): Promise<Entry[]> {
  const checkedAtMs = Date.now();
  const entry = (name: Entry["name"], mode: Entry["mode"], detail: string, probed = false): Entry =>
    ({ name, mode, detail, probed, checkedAtMs });
  async function probe(name: Entry["name"], required: string[], url: () => string, init: RequestInit = {}): Promise<Entry> {
    if (required.some((key) => !env[key]?.trim())) return entry(name, "blocked", "missing_config");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        fetch(url(), { ...init, signal: controller.signal, redirect: "error" }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, 4000);
        }),
      ]);
      await result.body?.cancel();
      return result.ok ? entry(name, "live", "probe_ok", true) : entry(name, "blocked", `http_${result.status}`);
    } catch {
      return entry(name, "blocked", controller.signal.aborted ? "timeout" : "request_failed");
    } finally {
      clearTimeout(timer);
    }
  }
  const base = (value: string | undefined) => value!.replace(/\/+$/, "");
  const esAuth = { Authorization: `ApiKey ${env.ELASTICSEARCH_API_KEY ?? ""}` };
  const spacetime = spacetimeConfig(env);
  return [
    entry("convex", "live", "request_served", true),
    ...await Promise.all([
      probe("spacetimedb", ["SPACETIMEDB_URI", "SPACETIMEDB_DATABASE"],
        () => `${spacetime.httpBase}/v1/database/${encodeURIComponent(env.SPACETIMEDB_DATABASE!)}/sql`, {
          method: "POST", body: "SELECT * FROM finding LIMIT 1", headers: {
            "Content-Type": "text/plain",
            ...(env.SPACETIMEDB_BRIDGE_TOKEN ? { Authorization: `Bearer ${env.SPACETIMEDB_BRIDGE_TOKEN}` } : {}),
          },
        }),
      probe("daytona", ["DAYTONA_API_KEY"], () => `${base(env.DAYTONA_API_URL ?? "https://app.daytona.io/api")}/sandbox`,
        { headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY ?? ""}` } }),
      probe("elastic", ["ELASTICSEARCH_URL", "ELASTICSEARCH_API_KEY"], () => `${base(env.ELASTICSEARCH_URL)}/`, { headers: esAuth }),
      probe("elastic_agent_builder", ["KIBANA_URL", "ELASTICSEARCH_API_KEY"], () => `${base(env.KIBANA_URL)}/api/agent_builder/agents`,
        { headers: { ...esAuth, "kbn-xsrf": "readiness" } }),
      probe("atlassian_jira", ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"], () => `${base(env.ATLASSIAN_SITE_URL)}/rest/api/3/myself`,
        { headers: { Authorization: `Basic ${btoa(`${env.ATLASSIAN_EMAIL ?? ""}:${env.ATLASSIAN_API_TOKEN ?? ""}`)}` } }),
    ]),
    entry("factory", env.FACTORY_API_KEY ? "live" : "blocked", env.FACTORY_API_KEY ? "configured_not_probed" : "missing_config"),
    ...(["atlassian_confluence", "simulator", "evaluator"] as const).map((name) => entry(name, "not_implemented", "probe_not_implemented")),
  ];
}

export const acquire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const row = await ctx.db.query("readinessSnapshots").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (row && (now - row.checkedAtMs < CACHE_MS || row.leaseUntilMs > now)) {
      return { refresh: false, integrations: row.integrations as Entry[] };
    }
    const leaseUntilMs = now + 10_000;
    if (row) await ctx.db.patch(row._id, { leaseUntilMs });
    else await ctx.db.insert("readinessSnapshots", { key: "global", checkedAtMs: 0, leaseUntilMs, integrations: [] });
    return { refresh: true, integrations: [] as Entry[] };
  },
});

export const save = internalMutation({
  args: { integrations: v.array(v.object({ name: v.string(), mode: v.string(), detail: v.string(), probed: v.boolean(), checkedAtMs: v.number() })) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("readinessSnapshots").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (row) await ctx.db.patch(row._id, { integrations: args.integrations, checkedAtMs: Date.now(), leaseUntilMs: 0 });
  },
});

export const get = internalAction({
  args: {},
  handler: async (ctx): Promise<{ integrations: Entry[] }> => {
    const cached = await ctx.runMutation(internal.readiness.acquire, {});
    if (!cached.refresh && cached.integrations.length) return { integrations: cached.integrations };
    const integrations = await probeIntegrations();
    await ctx.runMutation(internal.readiness.save, { integrations: integrations.map((item) => ({ ...item, detail: item.detail ?? "" })) });
    return { integrations };
  },
});
