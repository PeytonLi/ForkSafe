import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReadiness } from "../../server/readiness";
import { fetchReadiness } from "./readiness";

afterEach(() => vi.unstubAllGlobals());

function respond(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
}

describe("readiness response compatibility", () => {
  it("accepts local server reports without claiming a verified probe", async () => {
    const integrations = await buildReadiness({}, async () => ({ ok: true, status: 200 }), 1);
    respond({ integrations });
    expect(await fetchReadiness()).toEqual(integrations.map((item) => ({ ...item, probed: false })));
  });

  it("preserves explicit hosted probe results", async () => {
    const integrations = [true, false].map((probed) => ({ name: "convex", mode: "live", checkedAtMs: 1, probed }));
    respond({ integrations });
    expect(await fetchReadiness()).toEqual(integrations);
  });

  it("accepts an empty report", async () => {
    respond({ integrations: [] });
    expect(await fetchReadiness()).toEqual([]);
  });

  it("rejects malformed probe values", async () => {
    respond({ integrations: [{ name: "convex", mode: "live", checkedAtMs: 1, probed: "true" }] });
    await expect(fetchReadiness()).rejects.toMatchObject({ code: "invalid_data" });
  });

  it("rejects unavailable endpoints", async () => {
    respond({ error: "unavailable" }, 503);
    await expect(fetchReadiness()).rejects.toMatchObject({ code: "unavailable" });
  });
});
