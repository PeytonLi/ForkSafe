import { describe, expect, it } from "vitest";
import { parseHash, routeHref } from "../hooks";
import { FixtureClient } from "../services";
import { buildMarks } from "./TimelinePanel";
import { influenceEdges } from "./InfluenceGraph";
import { healthNote } from "./HealthPage";

const INV = "3b7d9303-7082-4b73-a3b6-1391b3e2fc4d";
const client = () => new FixtureClient({ latencyMs: 0, storage: null });

describe("routes", () => {
  it("round-trips health, tabs and focus ids", () => {
    expect(parseHash("#/health")).toEqual({ tab: "", page: "health" });
    const r = { investigationId: INV, tab: "evidence", focus: "abc" };
    expect(parseHash(routeHref(r))).toEqual(r);
    expect(parseHash(`#/investigations/${INV}`)).toMatchObject({ tab: "capture", focus: undefined });
  });
});

describe("timeline marks", () => {
  it("places every session, environment experiment, candidate and evaluation exactly once", async () => {
    const c = client();
    const w = await c.getWorkspace(INV);
    const marks = buildMarks(w, await c.listHandoffs(INV));
    const ids = marks.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of w.sessions) expect(ids).toContain(s.id);
    for (const x of w.experiments.filter((x) => x.environmentId)) expect(ids).toContain(x.id);
    for (const e of w.evaluations) expect(ids).toContain(e.id);
    expect(marks.filter((m) => m.row === "fixes")).toHaveLength(w.candidates.length);
    expect(marks.every((m) => m.endMs === undefined || m.endMs >= m.startMs)).toBe(true);
    expect(marks.find((m) => m.tone === "bad" && m.row === "experiments")).toBeDefined();
  });

  it("marks a job with a stale handoff as failed", async () => {
    const w = await client().getWorkspace(INV);
    const envId = w.environments[0]!.id;
    const marks = buildMarks(w, [
      { jobId: "j", jobKind: "run_experiment", environmentId: envId, stage: "admission_reserved", atMs: 1, stale: false },
      { jobId: "j", jobKind: "run_experiment", environmentId: envId, stage: "work_started", atMs: 2, stale: true },
    ]);
    expect(marks.find((m) => m.id === "job-j")).toMatchObject({ tone: "bad", startMs: 1, endMs: 2 });
  });
});

describe("influence edges", () => {
  it("links each candidate to the findings it was based on and flags cross-environment use", async () => {
    const c = client();
    const w = await c.getWorkspace(INV);
    const edges = influenceEdges(w, await c.listFindings(INV));
    const declared = w.candidates.reduce((n, x) => n + x.basedOnFindings.length, 0);
    expect(edges).toHaveLength(declared);
    expect(edges.some((e) => e.crossEnvironment)).toBe(true);
    expect(edges.some((e) => !e.crossEnvironment)).toBe(true);
  });
  it("ignores findings it cannot see", async () => {
    const w = await client().getWorkspace(INV);
    expect(influenceEdges(w, [])).toEqual([]);
  });
});

describe("health notes", () => {
  it("never calls an unprobed service live and explains impact when blocked", () => {
    const base = { name: "daytona" as const, checkedAtMs: 1 };
    expect(healthNote({ ...base, mode: "live", probed: false })).toMatch(/hasn't tested/);
    expect(healthNote({ ...base, mode: "blocked", probed: false })).toMatch(/can't start.*setup is missing/);
    expect(healthNote({ ...base, mode: "blocked", probed: true })).toMatch(/didn't respond/);
  });
});
