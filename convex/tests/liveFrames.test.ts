import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api.js";
import schema from "../schema.js";
import { LIVE_CHUNK_READER_PYTHON, parseChunkLines } from "../lib/liveRelay.js";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.replace(/^\.\.\//, ""),
    load,
  ]),
);
const experimentId = "22222222-2222-4222-8222-222222222222";
const investigationId = "11111111-1111-4111-8111-111111111111";
const frame = (tSec: number) => ({ tSec, bodies: [], contacts: [], cubePos: [0, 0, 0], attached: false, qpos: [], qvel: [], ctrl: [] });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function opened() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.liveFrames.open, { experimentId, investigationId });
  return t;
}

describe("live frame relay", () => {
  it("rejects gaps, accepts the missing chunk, and de-duplicates retries", async () => {
    const t = await opened();
    await expect(t.mutation(internal.liveFrames.appendChunk, { experimentId, seq: 1, frames: [frame(0.1)], final: false }))
      .resolves.toEqual({ accepted: false, reason: "gap" });
    await expect(t.mutation(internal.liveFrames.appendChunk, { experimentId, seq: 0, frames: [frame(0)], final: false }))
      .resolves.toEqual({ accepted: true });
    await expect(t.mutation(internal.liveFrames.appendChunk, { experimentId, seq: 0, frames: [frame(0)], final: false }))
      .resolves.toEqual({ accepted: false, reason: "duplicate" });
    await expect(t.mutation(internal.liveFrames.appendChunk, { experimentId, seq: 1, frames: [frame(0.1)], final: true }))
      .resolves.toEqual({ accepted: true });
    const chunks = await t.run((ctx) => ctx.db.query("liveChunks").collect());
    expect(chunks).toHaveLength(2);
  });

  it("makes opening idempotent and marks over-cap and oversized streams unavailable", async () => {
    const t = await opened();
    await t.mutation(internal.liveFrames.open, { experimentId, investigationId });
    for (let seq = 0; seq < 120; seq += 1) {
      await t.mutation(internal.liveFrames.appendChunk, { experimentId, seq, frames: [], final: false });
    }
    await expect(t.mutation(internal.liveFrames.appendChunk, { experimentId, seq: 120, frames: [], final: false }))
      .resolves.toEqual({ accepted: false, reason: "capped" });
    expect(await t.run((ctx) => ctx.db.query("liveStreams").unique())).toMatchObject({ status: "unavailable", reason: "chunk_cap" });

    const otherExperiment = "33333333-3333-4333-8333-333333333333";
    await t.mutation(internal.liveFrames.open, { experimentId: otherExperiment, investigationId });
    await expect(t.mutation(internal.liveFrames.appendChunk, {
      experimentId: otherExperiment, seq: 0, frames: [{ value: "x".repeat(65_000) }], final: false,
    })).resolves.toEqual({ accepted: false, reason: "too_large" });
    const rows = await t.run((ctx) => ctx.db.query("liveStreams").collect());
    expect(rows.find((row) => row.experimentId === otherExperiment)).toMatchObject({ status: "unavailable", reason: "chunk_too_large" });
  });

  it("schedules cleanup and removes chunks in batches before compacting the row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    const t = await opened();
    for (let seq = 0; seq < 70; seq += 1) {
      await t.mutation(internal.liveFrames.appendChunk, { experimentId, seq, frames: [], final: false });
    }
    await t.mutation(internal.liveFrames.finish, { experimentId, outcome: "finished" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("liveChunks").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("liveStreams").unique())).toMatchObject({ status: "finished", compacted: true, chunkCount: 0 });
  });

  it("marks streams stale and web latest returns only the last eight chunks ascending", async () => {
    const t = await opened();
    for (let seq = 0; seq < 10; seq += 1) {
      await t.mutation(internal.liveFrames.appendChunk, { experimentId, seq, frames: [frame(seq)], final: false });
    }
    await expect(t.query(api.web.live.latest, { experimentId })).rejects.toThrow(/unauthorized/);
    vi.stubEnv("FORKSAFE_PUBLIC_INVESTIGATION_IDS", investigationId);
    const snapshot = await t.query(api.web.live.latest, { experimentId });
    expect(snapshot?.chunks.map((chunk: { seq: number }) => chunk.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(snapshot?.status).toBe("streaming");

    const staleExperiment = "44444444-4444-4444-8444-444444444444";
    await t.mutation(internal.liveFrames.open, { experimentId: staleExperiment, investigationId });
    await t.run(async (ctx) => {
      const stream = await ctx.db.query("liveStreams").withIndex("by_experiment", (q) => q.eq("experimentId", staleExperiment)).unique();
      await ctx.db.patch(stream!._id, { updatedAtMs: Date.now() - 11 * 60_000 });
    });
    await t.mutation(internal.liveFrames.sweepStale, {});
    const stale = await t.run((ctx) => ctx.db.query("liveStreams").withIndex("by_experiment", (q) => q.eq("experimentId", staleExperiment)).unique());
    expect(stale).toMatchObject({ status: "unavailable", reason: "relay_stale" });
  });

  it("parses complete chunk lines, skips noise, and ignores a partial final line", () => {
    expect(LIVE_CHUNK_READER_PYTHON).not.toContain("'");
    const parsed = parseChunkLines([
      "provider diagnostic",
      JSON.stringify({ seq: 0, final: false, frames: [frame(0)] }),
      JSON.stringify({ seq: 1, final: true, frames: [frame(0.1)] }).slice(0, -3),
    ].join("\n"));
    expect(parsed).toEqual([{ seq: 0, final: false, frames: [frame(0)] }]);
  });
});
