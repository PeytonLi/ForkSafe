import { convexTest } from "convex-test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../schema.js";
import { api, internal } from "../_generated/api.js";
import { hmacSha256Hex } from "../lib/runnerAuth.js";

const modules = (import.meta as ImportMeta & { glob(pattern: string): Record<string, () => Promise<any>> }).glob("../**/*.ts");
const serviceToken = "runner-http-test-service-token";
const tokenUsage = {
  inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usageKnown: true,
};

type RunnerFixture = {
  credentialId: string;
  secret: string;
  investigationId: string;
  environmentId: string;
  jobId: string;
  attemptId: string;
  grantId: string;
  epoch: number;
  sessionId: string;
};

function createTest() {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  registerWorkpool(t, "daytonaPool");
  registerWorkpool(t, "outboxPool");
  return t;
}

async function signedPost(t: any, fixture: RunnerFixture, path: string, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = await hmacSha256Hex(fixture.secret, `${timestamp}.${rawBody}`);
  return await t.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forksafe-runner": fixture.credentialId,
      "x-forksafe-timestamp": timestamp,
      "x-forksafe-signature": signature,
    },
    body: rawBody,
  });
}

async function activeRunner(t: any): Promise<RunnerFixture> {
  const created = await t.mutation(api.investigations.create, {
    title: "runner http contract", requestedEnvironments: 1,
    idempotencyKey: crypto.randomUUID(), serviceToken,
  });
  await t.mutation(api.investigations.start, {
    investigationId: created.investigationId, expectedVersion: 1, serviceToken,
  });
  const environment = await t.run(async (ctx: any) => {
    const row = (await ctx.db.query("environments").collect())[0]!;
    await ctx.db.patch(row._id, { state: "active" });
    return row;
  });
  const credential = await t.mutation(internal.runnerControl.issueCredential, {
    investigationId: created.investigationId, environmentId: environment.appId,
  });
  const claim = await t.mutation(internal.runnerControl.claim, {
    credentialId: credential.credentialId, workerId: "route-test",
  });
  expect(claim).not.toBeNull();
  const lease = claim!.claimed;
  const grant = await t.mutation(internal.grants.create, {
    jobId: lease.jobId, attemptId: lease.attemptId, epoch: lease.epoch,
    investigationId: created.investigationId, environmentId: environment.appId, purpose: "runner",
  });
  await t.mutation(internal.grants.markInstalled, {
    grantId: grant.grantId, committed: true, mode: "fixture",
  });
  await t.mutation(internal.runnerControl.markGrantInstalled, {
    credentialId: credential.credentialId, attemptId: lease.attemptId, epoch: lease.epoch,
    grantId: grant.grantId, bridgeMode: "fixture",
  });
  const fixture: RunnerFixture = {
    credentialId: credential.credentialId, secret: credential.secret,
    investigationId: created.investigationId, environmentId: environment.appId,
    jobId: lease.jobId, attemptId: lease.attemptId, grantId: grant.grantId,
    epoch: lease.epoch, sessionId: crypto.randomUUID(),
  };
  const sessionResponse = await signedPost(t, fixture, "/runner/session", {
    attemptId: fixture.attemptId, epoch: fixture.epoch,
    session: { id: fixture.sessionId, state: "streaming", mode: "fixture", tokenUsage, createdAtMs: Date.now() },
  });
  expect(sessionResponse.status).toBe(200);
  return fixture;
}

function toolContext(fixture: RunnerFixture) {
  return {
    investigationId: fixture.investigationId, environmentId: fixture.environmentId,
    sessionId: fixture.sessionId, attemptId: fixture.attemptId, grantId: fixture.grantId,
    epoch: fixture.epoch,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  vi.stubEnv("INTEGRATION_SHARED_SECRET", serviceToken);
  vi.stubEnv("SPACETIMEDB_MODE", "fixture");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("signed runner HTTP routes", () => {
  it("dispatches every tool through its validated internal contract", async () => {
    const t = createTest();
    const fixture = await activeRunner(t);
    const context = toolContext(fixture);
    const tools: Array<{
      name: string;
      args: Record<string, unknown>;
      expected: Record<string, unknown>;
      callId?: string;
    }> = [
      { name: "inspect_failure", args: {}, expected: { mode: "live" }, callId: crypto.randomUUID() },
      { name: "read_source", args: { path: "../evaluation/withheld/manifest.json" }, expected: { status: "rejected", reason: "path_not_allowed" }, callId: crypto.randomUUID() },
      {
        name: "apply_patch",
        args: { diff: "", expectedHeadRevisionId: crypto.randomUUID(), rationale: "stale head", basedOnFindings: [] },
        expected: { status: "rejected", reason: "stale_head" }, callId: crypto.randomUUID(),
      },
      { name: "fork_candidate", args: { candidateId: crypto.randomUUID(), rationale: "missing candidate", basedOnFindings: [] }, expected: { status: "rejected", reason: "candidate_not_found" }, callId: crypto.randomUUID() },
      { name: "request_subtask", args: {}, expected: { status: "reserved" }, callId: crypto.randomUUID() },
      { name: "run_experiment", args: { caseId: "withheld-case", seed: 0, hypothesis: "", basedOnFindings: [] }, expected: { status: "rejected", reason: "case_not_public" } },
      { name: "propose_controller_revision", args: { source: "", rationale: "" }, expected: { status: "rejected", reason: "source_size_invalid" } },
      { name: "submit_candidate", args: { revisionId: crypto.randomUUID(), rationale: "", basedOnFindings: [] }, expected: { status: "rejected", reason: "finding_required" } },
      { name: "read_findings", args: { scope: "investigation", limit: 20 }, expected: { mode: "live", findings: [] } },
      { name: "write_finding", args: { kind: "behavioral_note", summary: "No evidence", evidence: [] }, expected: { status: "rejected", reason: "evidence_required" } },
      { name: "request_evidence", args: { query: "no experiments yet" }, expected: { mode: "live", experiments: [] } },
    ];

    for (const tool of tools) {
      const response = await signedPost(t, fixture, `/runner/tools/${tool.name}`, {
        ...context, ...tool.args, ...(tool.callId ? { callId: tool.callId } : {}),
      });
      expect(response.status, `${tool.name} status`).not.toBe(500);
      expect(response.status, `${tool.name} status`).toBe(200);
      expect(await response.json(), tool.name).toMatchObject(tool.expected);
    }

    const badSession = await signedPost(t, fixture, "/runner/tools/read_findings", {
      ...context, sessionId: crypto.randomUUID(), scope: "investigation", limit: 20,
    });
    expect(badSession.status).toBe(409);
    expect(await badSession.json()).toEqual({ error: "session_mismatch" });
  });

  it("validates checkpoint, heartbeat, completion routes and returns safe 400s for internal argument errors", async () => {
    const t = createTest();
    const fixture = await activeRunner(t);

    const invalidTool = await signedPost(t, fixture, "/runner/tools/write_finding", {
      ...toolContext(fixture), kind: "not-a-finding-kind", summary: "invalid", evidence: [],
    });
    expect(invalidTool.status).toBe(400);
    expect(await invalidTool.json()).toEqual({
      error: "invalid_request",
      message: "Request does not match the expected runner contract.",
    });

    const start = await signedPost(t, fixture, "/runner/start", {
      attemptId: fixture.attemptId, epoch: fixture.epoch,
    });
    expect(start.status).toBe(200);

    const checkpoint = await signedPost(t, fixture, "/runner/checkpoint", {
      attemptId: fixture.attemptId,
      epoch: fixture.epoch,
      checkpoint: {
        investigationId: fixture.investigationId, environmentId: fixture.environmentId,
        jobId: fixture.jobId, attemptId: fixture.attemptId, epoch: fixture.epoch,
        sessionId: fixture.sessionId, vendorSessionId: "vendor-session", turnIndex: 0, role: "primary",
        tokenUsage,
      },
    });
    expect(checkpoint.status).toBe(200);
    expect(await checkpoint.json()).toMatchObject({ ok: true, duplicate: false });

    const heartbeat = await signedPost(t, fixture, "/runner/heartbeat", {
      attemptId: fixture.attemptId, grantId: fixture.grantId, epoch: fixture.epoch,
    });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({ ok: true });

    const completion = {
      operationId: crypto.randomUUID(), jobId: fixture.jobId,
      attemptId: fixture.attemptId, grantId: fixture.grantId, epoch: fixture.epoch,
      outcome: "succeeded", result: {}, sessions: [],
      finishedAtMs: Date.now(),
    };
    const complete = await signedPost(t, fixture, "/runner/complete", completion);
    expect(complete.status).toBe(200);
    const firstResponse = await complete.json();
    expect(firstResponse).toMatchObject({ accepted: true });
    await t.mutation(internal.runnerControl.revokeCredentials, {
      investigationId: fixture.investigationId, reason: "replay test",
    });
    const replay = await signedPost(t, fixture, "/runner/complete", completion);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstResponse);

    const changedBody = await signedPost(t, fixture, "/runner/complete", { ...completion, result: { changed: true } });
    expect(changedBody.status).toBe(401);
    const otherOperation = await signedPost(t, fixture, "/runner/complete", { ...completion, operationId: crypto.randomUUID() });
    expect(otherOperation.status).toBe(401);
    const rawBody = JSON.stringify(completion);
    const badSignature = await t.fetch("/runner/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forksafe-runner": fixture.credentialId,
        "x-forksafe-timestamp": String(Date.now()),
        "x-forksafe-signature": "0".repeat(64),
      },
      body: rawBody,
    });
    expect(badSignature.status).toBe(401);
  });

  it("enforces global model-turn reservations and accepts owned usage after revocation", async () => {
    const t = createTest();
    const fixture = await activeRunner(t);
    const reservationArgs = (turnIndex: number) => ({
      attemptId: fixture.attemptId, grantId: fixture.grantId, epoch: fixture.epoch,
      sessionId: fixture.sessionId, turnKey: `${fixture.attemptId}:${fixture.sessionId}:${turnIndex}`,
    });
    const granted = [];
    for (let turnIndex = 0; turnIndex < 4; turnIndex += 1) {
      const response = await signedPost(t, fixture, "/runner/model_turn/reserve", reservationArgs(turnIndex));
      expect(response.status).toBe(200);
      granted.push(await response.json());
    }
    expect(granted.map((row: any) => row.granted)).toEqual([true, true, true, true]);
    expect(await (await signedPost(t, fixture, "/runner/model_turn/reserve", reservationArgs(0))).json())
      .toMatchObject({ granted: true, reservationId: granted[0].reservationId });
    const blocked = await signedPost(t, fixture, "/runner/model_turn/reserve", reservationArgs(4));
    expect(await blocked.json()).toMatchObject({
      granted: false, retryAfterMs: 2_000, reason: "global_capacity_exhausted",
    });

    await t.run(async (ctx: any) => {
      const reservation = await ctx.db.query("reservations")
        .withIndex("by_turn_key", (q: any) => q.eq("turnKey", reservationArgs(0).turnKey)).unique();
      await ctx.db.patch(reservation._id, { leasedUntilMs: Date.now() - 1 });
    });
    const freed = await signedPost(t, fixture, "/runner/model_turn/reserve", reservationArgs(4));
    expect(await freed.json()).toMatchObject({ granted: true });

    const heartbeat = await signedPost(t, fixture, "/runner/heartbeat", {
      attemptId: fixture.attemptId, grantId: fixture.grantId, epoch: fixture.epoch,
    });
    const heartbeatResult = await heartbeat.json();
    const activeReservations = await t.run(async (ctx: any) =>
      await ctx.db.query("reservations").withIndex("by_kind_status", (q: any) =>
        q.eq("kind", "model_turn").eq("status", "active")).collect(),
    );
    expect(activeReservations.filter((row: any) => row.holder.attemptId === fixture.attemptId)
      .every((row: any) => row.leasedUntilMs === heartbeatResult.leasedUntilMs)).toBe(true);

    const release = await signedPost(t, fixture, "/runner/model_turn/release", reservationArgs(1));
    expect(await release.json()).toEqual({ released: true });
    await t.mutation(internal.runnerControl.revokeCredentials, {
      investigationId: fixture.investigationId, reason: "usage grace test",
    });
    const usage = await signedPost(t, fixture, "/runner/usage", {
      attemptId: fixture.attemptId, sessionId: fixture.sessionId,
      tokenUsage: { ...tokenUsage, inputTokens: 7, outputTokens: 3 },
      unknownTurns: 0, partialTurns: 1,
    });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual({ recorded: true });
    const saved = await t.run(async (ctx: any) =>
      await ctx.db.query("sessions").withIndex("by_appId", (q: any) => q.eq("appId", fixture.sessionId)).unique(),
    );
    expect(saved.tokenUsage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(saved.usagePartialTurns).toBe(1);
  });

  it("returns stale_epoch 409s for heartbeat, tools, model-turn reserve, and completion", async () => {
    const t = createTest();
    const fixture = await activeRunner(t);
    await t.run(async (ctx: any) => {
      const job = await ctx.db.query("jobs").withIndex("by_appId", (q: any) => q.eq("appId", fixture.jobId)).unique();
      await ctx.db.patch(job._id, { epoch: fixture.epoch + 1 });
    });
    const requests = [
      ["/runner/heartbeat", {
        attemptId: fixture.attemptId, grantId: fixture.grantId, epoch: fixture.epoch,
      }],
      ["/runner/tools/read_findings", {
        ...toolContext(fixture), scope: "investigation", limit: 20,
      }],
      ["/runner/model_turn/reserve", {
        attemptId: fixture.attemptId, grantId: fixture.grantId, epoch: fixture.epoch,
        sessionId: fixture.sessionId, turnKey: `${fixture.attemptId}:${fixture.sessionId}:0`,
      }],
      ["/runner/complete", {
        operationId: crypto.randomUUID(), jobId: fixture.jobId, attemptId: fixture.attemptId,
        grantId: fixture.grantId, epoch: fixture.epoch, outcome: "succeeded", result: {}, sessions: [],
        finishedAtMs: Date.now(),
      }],
    ] as const;
    for (const [path, body] of requests) {
      const response = await signedPost(t, fixture, path, body);
      expect(response.status, path).toBe(409);
      expect(await response.json(), path).toEqual({ error: "stale_epoch" });
    }
  });
});
