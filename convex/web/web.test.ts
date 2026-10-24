import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api.js";
import schema from "../schema.js";
import { parseAsk, toWebAnswer } from "./askPolicy.js";
import { toDocuments } from "./elasticAgent.js";

// Vite keys files in this directory as "./x.ts"; convex-test needs paths from the convex root.
const modules = Object.fromEntries(Object.entries(import.meta.glob("../**/*.ts")).map(([key, load]) => [key.startsWith("./") ? `../web/${key.slice(2)}` : key, load]));
const inv = "11111111-1111-4111-8111-111111111111";
const other = "99999999-9999-4999-8999-999999999999";
const env = "44444444-4444-4444-8444-444444444444";
const attempt = "55555555-5555-4555-8555-555555555555";
const findingId = "66666666-6666-4666-8666-666666666666";
const revokedFindingId = "77777777-7777-4777-8777-777777777777";
const withheldExp = "88888888-8888-4888-8888-888888888888";
const artifactId = "33333333-3333-4333-8333-333333333333";
const user = { subject: "user-1", issuer: "https://test", tokenIdentifier: "https://test|user-1" };
const simCase = { caseId: "baseline", suite: "original" as const, seed: 0, sceneOverrides: {} };

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function seeded() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (const appId of [inv, other]) {
      await ctx.db.insert("investigations", {
        appId, title: "T", state: "searching", cancelStatus: "none", cancelEpoch: 0, version: 1,
        requestedEnvironments: 1, baselineCase: simCase, baselineExperimentId: attempt,
        budget: { wallTimeMs: 1000, maxExperimentsPerEnv: 1, maxCandidatesPerEnv: 1, maxFinalCandidates: 1 },
        idempotencyKey: `seed-${appId}`, createdAtMs: 1, updatedAtMs: 1,
      });
    }
    const finding = (appId: string, investigationId: string, evidenceArtifact?: string) => ctx.db.insert("findings", {
      appId, investigationId, environmentId: env, attemptId: attempt, epoch: 1, kind: "collision_frame", claim: "observation",
      summary: `Cube clips the divider (${appId.slice(0, 4)})`, spacetimeCommitted: true, createdAtMs: 10,
      evidence: [{ kind: "contact_event", locator: { tSec: 4.1 }, ...(evidenceArtifact ? { artifactId: evidenceArtifact } : {}) }],
    });
    await finding(findingId, inv);
    await finding(revokedFindingId, inv, artifactId);
    await ctx.db.insert("artifacts", {
      appId: artifactId, kind: "replay", sha256: "a".repeat(64), bytes: 1, storage: "convex", storageKey: "k", createdAtMs: 1,
      investigationId: inv, visibility: "internal", revokedAtMs: 5,
    });
    await ctx.db.insert("experiments", {
      appId: withheldExp, investigationId: inv, attemptId: attempt, epoch: 1, purpose: "evaluation", suite: "withheld",
      simCase: { ...simCase, suite: "withheld" }, status: "succeeded", failureKinds: [], completed: true, changedFunctions: [],
      engineVersion: "mujoco", assetsSha256: "b".repeat(64), controllerSha256: "c".repeat(64), spacetimeCommitted: true, startedAtMs: 20,
    });
  });
  return t;
}

describe("web/health:pipeline", () => {
  it("fails closed without an identity", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.web.health.pipeline, {})).rejects.toThrow(/unauthorized/);
  });

  it("counts held sandboxes, live runners and outbox rows, ignoring finished ones", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      const statuses = ["ready", "creating", "ambiguous_terminate", "terminated", "error"] as const;
      for (const [i, status] of statuses.entries()) {
        await ctx.db.insert("sandboxOps", {
          appId: `op-${i}`, purpose: "runner", investigationId: inv, snapshot: "s", resources: { cpu: 1, memoryGiB: 1, diskGiB: 1 },
          provider: "daytona", status, reservationId: `r-${i}`, attempts: 1, createdAtMs: 1, updatedAtMs: 1,
        });
      }
      const cred = (appId: string, extra: { revokedAtMs?: number; expiresAtMs: number }) => ctx.db.insert("runnerCredentials", {
        appId, investigationId: inv, environmentId: env, secret: "x", createdAtMs: 1, ...extra,
      });
      await cred("c1", { expiresAtMs: now + 60_000 });
      await cred("c2", { expiresAtMs: now + 60_000, revokedAtMs: 1 });
      await cred("c3", { expiresAtMs: now - 1 });
      const box = (appId: string, status: "pending" | "delivered" | "dead", createdAtMs: number) => ctx.db.insert("outbox", {
        appId, destination: "elastic_index", status, idempotencyKey: appId, operationId: appId, payload: {}, attempts: 1,
        createdAtMs, source: "convex", nextAttemptAtMs: createdAtMs,
      });
      await box("o1", "pending", 300);
      await box("o2", "pending", 200);
      await box("o3", "dead", 100);
      await box("o4", "delivered", 50);
    });
    const p = await t.withIdentity(user).query(api.web.health.pipeline, {});
    expect(p).toMatchObject({ activeSandboxes: 3, sandboxCap: 5, runners: 1, outboxBacklog: 2, outboxDead: 1, oldestBacklogAtMs: 200 });
  });
});

describe("web/timeline:handoffs", () => {
  it("returns only this investigation's handoffs, oldest first, and requires read access", async () => {
    const t = await seeded();
    await t.run(async (ctx) => {
      const job = (appId: string, investigationId: string) => ctx.db.insert("jobs", {
        appId, kind: "run_experiment", state: "running", investigationId, environmentId: env, epoch: 1, idempotencyKey: appId,
        payload: {}, attemptsUsed: 1, maxAttempts: 2, operationId: appId, admittedCancelEpoch: 0, dependsOn: [], createdAtMs: 1, updatedAtMs: 1,
      });
      await job("job-a", inv);
      await job("job-b", other);
      for (const [stage, atMs, jobId] of [["work_started", 30, "job-a"], ["admission_reserved", 10, "job-a"], ["admission_reserved", 5, "job-b"]] as const) {
        await ctx.db.insert("handoffs", { operationId: jobId, jobId, stage, detail: {}, atMs, epoch: 1, stale: false });
      }
    });
    await expect(t.query(api.web.timeline.handoffs, { investigationId: inv })).rejects.toThrow(/unauthorized/);
    await expect(t.withIdentity(user).query(api.web.timeline.handoffs, { investigationId: "not-a-uuid" })).rejects.toThrow(/must_be_uuid/);
    const rows = await t.withIdentity(user).query(api.web.timeline.handoffs, { investigationId: inv });
    expect(rows.map((r) => [r.jobId, r.stage, r.atMs])).toEqual([["job-a", "admission_reserved", 10], ["job-a", "work_started", 30]]);
    expect(rows[0]).toMatchObject({ jobKind: "run_experiment", environmentId: env, stale: false });
  });
});

describe("ask policy", () => {
  it("normalizes questions and rejects empty, oversized, control-character and cross-investigation questions", () => {
    expect(parseAsk({ investigationId: inv, question: "  why   did it fail? " }).question).toBe("why did it fail?");
    for (const question of ["hi", "x".repeat(501), "why\u0007", "compare all investigations"]) {
      expect(() => parseAsk({ investigationId: inv, question })).toThrow(/invalid_input|out_of_scope/);
    }
    expect(() => parseAsk({ investigationId: "nope", question: "why did it fail?" })).toThrow(/invalid_input/);
    expect(parseAsk({ investigationId: inv, question: `what about ${findingId} in ${inv}?` }).mentionedIds).toEqual([findingId]);
  });

  it("only counts a live answer with validated citations and nothing withheld as enough evidence", () => {
    const cite = { id: findingId, docType: "finding", canonical: { summary: "Cube clips divider", environmentId: env } };
    expect(toWebAnswer({ mode: "live", answer: "Because…", citations: [cite], droppedCitations: [] })).toMatchObject({
      enoughEvidence: true, answer: "Because…", citations: [{ id: findingId, summary: "Cube clips divider", environmentId: env }],
    });
    const tainted = toWebAnswer({ mode: "live", answer: "No fully validated answer", citations: [cite], droppedCitations: [{ id: "x", reason: "revoked" }] });
    expect(tainted).toMatchObject({ enoughEvidence: false, withheld: [{ id: "x", reason: "revoked" }] });
    expect(tainted.answer).toBeUndefined();
    expect(toWebAnswer({ mode: "blocked", reason: "Agent Builder request failed" })).toMatchObject({ enoughEvidence: false, citations: [] });
    expect(toWebAnswer({ mode: "live", answer: "x", citations: [{ id: "c", docType: "candidate", canonical: {} }] }).enoughEvidence).toBe(false);
  });
});

describe("web/ask:ask", () => {
  const liveEnv = () => {
    vi.stubEnv("ELASTIC_AGENT_BUILDER_MODE", "cloud");
    vi.stubEnv("KIBANA_URL", "https://kibana.test");
    vi.stubEnv("KIBANA_API_KEY", ["unit", "test", "kibana"].join("-"));
  };

  it("requires a signed-in identity even when the investigation is public", async () => {
    vi.stubEnv("FORKSAFE_PUBLIC_INVESTIGATION_IDS", inv);
    const t = await seeded();
    await expect(t.action(api.web.ask.ask, { investigationId: inv, question: "why did it fail?" })).rejects.toThrow(/unauthorized/);
  });

  it("rejects ids from another investigation and unknown investigations before calling Elastic", async () => {
    liveEnv();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const t = await seeded();
    const asUser = t.withIdentity(user);
    await expect(asUser.action(api.web.ask.ask, { investigationId: inv, question: `what did ${other} find?` })).rejects.toThrow(/out_of_scope/);
    await expect(asUser.action(api.web.ask.ask, { investigationId: "12121212-1212-4212-8212-121212121212", question: "why did it fail?" })).rejects.toThrow(/investigation_not_found/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports honestly when the agent is not configured", async () => {
    const t = await seeded();
    const answer = await t.withIdentity(user).action(api.web.ask.ask, { investigationId: inv, question: "why did it fail?" });
    expect(answer).toMatchObject({ mode: "not_implemented", enoughEvidence: false, citations: [], withheld: [] });
  });

  it("validates citations against Convex records: current finding accepted, revoked and withheld sources dropped", async () => {
    liveEnv();
    const t = await seeded();
    const record = await t.run(async (ctx) => ctx.db.query("findings").withIndex("by_appId", (q) => q.eq("appId", findingId)).unique());
    const contract = { id: findingId, investigationId: inv, environmentId: env, kind: "collision_frame", summary: record!.summary,
      evidence: [{ kind: "contact_event", locator: { tSec: 4.1 } }], createdAtMs: 10 };
    const version = toDocuments(contract).find((d) => d.id === findingId)!.body.sourceVersion;
    const reply = (citations: unknown[]) => vi.fn().mockResolvedValue(Response.json({ response: { message: "The cube clips the divider." }, steps: [citations] }));

    let fetcher = reply([{ docType: "finding", id: findingId, investigationId: inv, sourceVersion: version }]);
    vi.stubGlobal("fetch", fetcher);
    const ok = await t.withIdentity(user).action(api.web.ask.ask, { investigationId: inv, question: "why did the cube hit the divider?" });
    expect(ok).toMatchObject({ mode: "live", enoughEvidence: true, answer: "The cube clips the divider.", citations: [{ id: findingId, docType: "finding", environmentId: env }], withheld: [] });
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.input).toContain(inv);

    fetcher = reply([
      { docType: "finding", id: findingId, investigationId: inv, sourceVersion: "stale-version" },
      { docType: "evidence", id: `${revokedFindingId}:0`, investigationId: inv, sourceVersion: "v" },
      { docType: "experiment_result", id: withheldExp, investigationId: inv, sourceVersion: "v" },
    ]);
    vi.stubGlobal("fetch", fetcher);
    const dropped = await t.withIdentity(user).action(api.web.ask.ask, { investigationId: inv, question: "why did the cube hit the divider?" });
    expect(dropped.enoughEvidence).toBe(false);
    expect(dropped.answer).toBeUndefined();
    expect(Object.fromEntries(dropped.withheld.map((w) => [w.id, w.reason]))).toEqual({
      [findingId]: "stale", [`${revokedFindingId}:0`]: "revoked", [withheldExp]: "unauthorized",
    });
  });
});
