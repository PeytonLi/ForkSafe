import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema.js";
import { internal } from "./_generated/api.js";
import { probeIntegrations } from "./readiness.js";

const modules = import.meta.glob("./**/*.ts");
const env = {
  SPACETIMEDB_URI: "https://spacetime.invalid",
  SPACETIMEDB_DATABASE: "forksafe",
  SPACETIMEDB_BRIDGE_TOKEN: "sentinel-spacetime",
  DAYTONA_API_KEY: "sentinel-daytona",
  ELASTICSEARCH_URL: "https://elastic.invalid",
  ELASTICSEARCH_API_KEY: "sentinel-elastic",
  KIBANA_URL: "https://kibana.invalid",
  ATLASSIAN_SITE_URL: "https://jira.invalid",
  ATLASSIAN_EMAIL: "sentinel-email",
  ATLASSIAN_API_TOKEN: "sentinel-jira",
  FACTORY_API_KEY: "sentinel-factory",
};
const remoteNames = ["spacetimedb", "daytona", "elastic", "elastic_agent_builder", "atlassian_jira"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("readiness probes", () => {
  it("reports each successful remote request as live and probed, with configured-only Factory", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const entries = await probeIntegrations(env);
    for (const name of remoteNames) expect(entries.find((r) => r.name === name)).toMatchObject({ mode: "live", probed: true });
    expect(entries.find((r) => r.name === "convex")).toMatchObject({ mode: "live", probed: true });
    expect(entries.find((r) => r.name === "factory")).toMatchObject({ mode: "live", probed: false });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.find(([url]) => url.includes("/sql"))?.[1]).toMatchObject({ method: "POST", body: "SELECT * FROM finding LIMIT 1" });
  });

  it("reports 401s honestly without exposing credentials or response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(env), { status: 401 })));
    const entries = await probeIntegrations(env);
    for (const name of remoteNames) expect(entries.find((r) => r.name === name)).toMatchObject({ mode: "blocked", probed: false, detail: "http_401" });
    expect(JSON.stringify({ integrations: entries })).not.toContain("sentinel-");
  });

  it("bounds all parallel requests to four seconds, even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const pending = probeIntegrations(env);
    expect(fetch).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(4000);
    for (const entry of (await pending).filter((r) => remoteNames.includes(r.name))) {
      expect(entry).toMatchObject({ mode: "blocked", probed: false, detail: "timeout" });
    }
  });

  it("blocks missing configuration without making requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const entries = await probeIntegrations({});
    for (const name of [...remoteNames, "factory"]) expect(entries.find((r) => r.name === name)).toMatchObject({ mode: "blocked", probed: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes thrown errors including credential-bearing URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("https://sentinel-user:sentinel-password@host.invalid sentinel-elastic"); }));
    const json = JSON.stringify({ integrations: await probeIntegrations(env) });
    expect(json).not.toContain("sentinel-");
    expect(json).not.toContain("host.invalid");
    expect(json).toContain("request_failed");
  });
});

describe("persistent readiness cache", () => {
  it("probes inline rather than returning an empty snapshot during the initial refresh lease", async () => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const t = convexTest(schema, modules);
    await t.mutation(internal.readiness.acquire, {});
    const result = await t.action(internal.readiness.get, {});
    expect(result.integrations.length).toBeGreaterThan(0);
    for (const name of remoteNames) expect(result.integrations.find((r: { name: string }) => r.name === name)).toMatchObject({ mode: "live", probed: true });
  });

  it("serves cached snapshots without fetches, then refreshes after 60 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const t = convexTest(schema, modules);
    const first = await t.action(internal.readiness.get, {});
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(first)).not.toContain("sentinel-");
    fetch.mockClear();
    vi.setSystemTime(Date.now() + 59_999);
    expect(await t.action(internal.readiness.get, {})).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 2);
    await t.action(internal.readiness.get, {});
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("allows only one refresh lease for concurrent requests and recovers expired leases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.readiness.acquire, {})).toMatchObject({ refresh: true });
    expect(await t.mutation(internal.readiness.acquire, {})).toMatchObject({ refresh: false });
    vi.setSystemTime(Date.now() + 10_001);
    expect(await t.mutation(internal.readiness.acquire, {})).toMatchObject({ refresh: true });
  });

  it("serves readiness JSON and JSON 404s without swallowing SPA deep links", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.readiness.acquire, {});
    await t.mutation(internal.readiness.save, { integrations: [{ name: "convex", mode: "live", detail: "probe_ok", checkedAtMs: Date.now(), probed: true }] });
    const response = await t.fetch("/api/readiness");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ integrations: [{ name: "convex", probed: true }] });
    const missing = await t.fetch("/api/x");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
  });
});
