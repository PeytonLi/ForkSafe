import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { requireServiceToken } from "./lib/auth.js";
import { GRANT_TTL_MS } from "./lib/constants.js";
import { verifyRunnerSignature } from "./lib/runnerAuth.js";
import { traceLog } from "./lib/tracing.js";

/** HTTP surface for trusted runner sandboxes. Requests are signed with the
 *  sandbox's scoped credential; the deploy key, service token and bridge
 *  secret never leave Convex. */

const MAX_BODY_BYTES = 512 * 1024;
const TOOL_NAMES = ["inspect_failure", "read_source", "apply_patch", "fork_candidate", "request_subtask", "run_experiment", "propose_controller_revision", "submit_candidate", "read_findings", "write_finding", "request_evidence"] as const;
const INVALID_ARGUMENT_MESSAGE = "Request does not match the expected runner contract.";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function errorCode(error: unknown): string {
  if (isArgumentValidationError(error)) return "invalid_request";
  if (error instanceof ConvexError) return typeof error.data === "string" ? error.data : "error";
  if (error instanceof Error && error.message === "unauthorized") return "unauthorized";
  return "internal_error";
}

function isArgumentValidationError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "ArgumentValidationError"
      || error.message.startsWith("ArgumentValidationError:")
      || error.message.startsWith("Validator error:"));
}

function errorResponse(error: unknown, fallbackStatus: number): Response {
  if (isArgumentValidationError(error)) {
    return json({ error: "invalid_request", message: INVALID_ARGUMENT_MESSAGE }, 400);
  }
  const code = errorCode(error);
  if (code === "fenced" || code === "stale_epoch") return json({ error: "stale_epoch" }, 409);
  return json({ error: code }, fallbackStatus);
}

async function authenticateRaw(ctx: any, request: Request, rawBody: string, options: { ignoreCredentialStatus?: boolean; ignoreRevocation?: boolean; ignoreExpiration?: boolean } = {}): Promise<{ ok: true; credential: any; body: any } | { ok: false; response: Response }> {
  if (rawBody.length > MAX_BODY_BYTES) return { ok: false, response: json({ error: "body_too_large" }, 413) };
  const credentialId = request.headers.get("x-forksafe-runner");
  const credential = credentialId ? await ctx.runQuery(internal.runnerControl.getCredential, { credentialId }) : null;
  const verdict = await verifyRunnerSignature(credential, {
    credentialId, timestamp: request.headers.get("x-forksafe-timestamp"), signature: request.headers.get("x-forksafe-signature"),
  }, rawBody, Date.now(), options);
  if (!verdict.ok) return { ok: false, response: json({ error: "unauthorized", reason: verdict.reason }, 401) };
  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { ok: false, response: json({ error: "invalid_json" }, 400) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, response: json({ error: "invalid_body" }, 400) };
  return { ok: true, credential, body };
}

async function authenticate(ctx: any, request: Request): Promise<{ ok: true; credential: any; body: any } | { ok: false; response: Response }> {
  return authenticateRaw(ctx, request, await request.text());
}

async function sha256(rawBody: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function contractJob(job: any) {
  return {
    id: job.appId, kind: job.kind, state: job.state, investigationId: job.investigationId,
    ...(job.environmentId ? { environmentId: job.environmentId } : {}), epoch: job.epoch,
    ...(job.activeAttemptId ? { activeAttemptId: job.activeAttemptId } : {}), idempotencyKey: job.idempotencyKey,
    payload: job.payload ?? {}, attemptsUsed: job.attemptsUsed, maxAttempts: job.maxAttempts,
    createdAtMs: job.createdAtMs, updatedAtMs: job.updatedAtMs,
  };
}

export function registerRunnerRoutes(router: HttpRouter): void {
  router.route({
    path: "/runner/claim",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      traceLog("/runner/claim", request);
      const auth = await authenticate(ctx, request);
      if (!auth.ok) return auth.response;
      const workerId = typeof auth.body.workerId === "string" && auth.body.workerId.trim() ? auth.body.workerId.slice(0, 120) : "runner";
      try {
        const claimed = await ctx.runMutation(internal.runnerControl.claim, { credentialId: auth.credential.appId, workerId });
        if (!claimed) return json({ lease: null });
        const { claimed: lease, job, investigation, environment, checkpoint } = claimed;
        const grant = await ctx.runMutation(internal.grants.create, {
          jobId: job.appId, attemptId: lease.attemptId, epoch: lease.epoch, investigationId: job.investigationId,
          environmentId: job.environmentId, purpose: "runner",
        });
        const install = await ctx.runAction(internal.bridge.installGrant, {
          grantId: grant.grantId, jobId: job.appId, attemptId: lease.attemptId, epoch: lease.epoch, investigationId: job.investigationId,
          environmentId: job.environmentId,
          operations: ["heartbeat", "acquire_revision_lease", "renew_revision_lease", "release_revision_lease", "commit_revision", "record_artifact", "record_experiment", "record_finding", "submit_candidate"],
          artifactPrefixes: [`inv/${job.investigationId}/`], maxBytes: 64 * 1024 * 1024, expiresAtMs: grant.expiresAtMs,
        });
        if (!install.committed && (install.mode === "live" || install.mode === "local")) {
          await ctx.runMutation(internal.runnerControl.failGrantInstall, { credentialId: auth.credential.appId, attemptId: lease.attemptId, epoch: lease.epoch, error: install.error ?? "grant_install_failed" });
          return json({ lease: null, retryAfterMs: 5_000, reason: "grant_install_failed" });
        }
        await ctx.runMutation(internal.runnerControl.markGrantInstalled, { credentialId: auth.credential.appId, attemptId: lease.attemptId, epoch: lease.epoch, grantId: grant.grantId, bridgeMode: install.mode });
        const baselineBundle = await ctx.runQuery(internal.bundles.get, { key: "baseline_controller" });
        const baselineBlob = baselineBundle?.storageId ? await ctx.storage.get(baselineBundle.storageId) : null;
        const baselineControllerSource = baselineBlob ? (await baselineBlob.text()).slice(0, 20_000) : undefined;
        const payload = {
          ...(job.payload ?? {}),
          ...(job.attemptsUsed > 1 && checkpoint ? { resume: checkpoint } : {}),
          repair: {
            investigationTitle: investigation.title, environmentIndex: environment.index, baselineCase: investigation.baselineCase,
            ...(baselineControllerSource ? { baselineControllerSource } : {}),
            failureSummary: job.payload?.failureSummary ?? "The baseline controller collides with the divider while carrying the cube.",
            findingsDigest: "Call read_findings to see what other environments found.",
            budgets: { maxExperiments: environment.budgets.maxExperiments, experimentsUsed: environment.experimentsUsed, maxCandidates: environment.budgets.maxCandidates, candidatesUsed: environment.candidatesUsed },
          },
        };
        return json({
          lease: {
            job: { ...contractJob(job), state: "granted", payload },
            attempt: { id: lease.attemptId, jobId: job.appId, epoch: lease.epoch, state: "leased", workerId, leasedUntilMs: lease.leaseExpiresAtMs, lastHeartbeatMs: Date.now(), startedAtMs: Date.now() },
            grant: {
              id: grant.grantId, jobId: job.appId, attemptId: lease.attemptId, epoch: lease.epoch, investigationId: job.investigationId,
              environmentId: job.environmentId, scope: { operations: TOOL_NAMES.slice(), artifactPrefixes: [`inv/${job.investigationId}/`], maxBytes: 64 * 1024 * 1024 },
              expiresAtMs: Math.min(grant.expiresAtMs, Date.now() + GRANT_TTL_MS),
            },
          },
          bridgeMode: install.mode,
        });
      } catch (error) {
        const code = errorCode(error);
        return errorResponse(error, code === "unauthorized" ? 401 : 409);
      }
    }),
  });

  for (const endpoint of ["claim", "release"] as const) {
    router.route({
      path: `/runner/pool/${endpoint}`,
      method: "POST",
      handler: httpAction(async (ctx, request) => {
        const poolToken = process.env.RUNNER_POOL_TOKEN;
        if (!poolToken) return json({ error: "pool_not_configured" }, 503);
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
        try {
          requireServiceToken(token, poolToken);
        } catch {
          return json({ error: "unauthorized" }, 401);
        }
        let body: any;
        try {
          const raw = await request.text();
          if (raw.length > 4_096) return json({ error: "body_too_large" }, 413);
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_body" }, 400);
        if (endpoint === "claim") {
          if (typeof body.poolWorkerId !== "string" || !/^[A-Za-z0-9._:-]{3,120}$/.test(body.poolWorkerId)) {
            return json({ error: "invalid_body" }, 400);
          }
          if (process.env.RUNNER_LAUNCH_MODE !== "external") return json({ error: "pool_disabled" }, 409);
          try {
            const claimed = await ctx.runMutation(internal.runnerPool.claim, { poolWorkerId: body.poolWorkerId });
            if (!claimed) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
            const siteUrl = new URL(request.url).origin;
            return json({ ...claimed, jobSourceUrl: siteUrl, controlUrl: siteUrl });
          } catch (error) {
            return errorResponse(error, 409);
          }
        }
        if (typeof body.poolWorkerId !== "string" || !/^[A-Za-z0-9._:-]{3,120}$/.test(body.poolWorkerId)
          || typeof body.credentialId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.credentialId)) {
          return json({ error: "invalid_body" }, 400);
        }
        try {
          return json(await ctx.runMutation(internal.runnerPool.release, {
            poolWorkerId: body.poolWorkerId,
            credentialId: body.credentialId,
          }));
        } catch (error) {
          return errorResponse(error, 409);
        }
      }),
    });
  }

  router.route({
    path: "/runner/heartbeat",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      traceLog("/runner/heartbeat", request);
      const auth = await authenticate(ctx, request);
      if (!auth.ok) return auth.response;
      const { attemptId, grantId, epoch } = auth.body;
      if (typeof attemptId !== "string" || typeof grantId !== "string" || typeof epoch !== "number") return json({ ok: false, reason: "unknown_attempt" });
      try {
        const result = await ctx.runMutation(internal.runnerControl.heartbeat, { credentialId: auth.credential.appId, attemptId, grantId, epoch });
        if (result.reason === "fenced") return json({ error: "stale_epoch" }, 409);
        return json(result);
      } catch (error) {
        if (isArgumentValidationError(error)) return errorResponse(error, 400);
        const code = errorCode(error);
        if (code === "fenced" || code === "stale_epoch") return errorResponse(error, 409);
        return json({ ok: false, reason: code === "unauthorized" ? "revoked" : "unknown_attempt" }, code === "unauthorized" ? 401 : 200);
      }
    }),
  });

  for (const endpoint of ["reserve", "release"] as const) {
    router.route({
      path: `/runner/model_turn/${endpoint}`,
      method: "POST",
      handler: httpAction(async (ctx, request) => {
        traceLog(`/runner/model_turn/${endpoint}`, request);
        const auth = await authenticate(ctx, request);
        if (!auth.ok) return auth.response;
        const { attemptId, grantId, epoch, sessionId, turnKey } = auth.body;
        if (typeof attemptId !== "string" || typeof grantId !== "string" || typeof epoch !== "number"
          || typeof sessionId !== "string" || typeof turnKey !== "string") return json({ error: "invalid_body" }, 400);
        try {
          const fn = endpoint === "reserve" ? internal.runnerControl.reserveModelTurn : internal.runnerControl.releaseModelTurn;
          return json(await ctx.runMutation(fn, {
            credentialId: auth.credential.appId, attemptId, grantId, epoch, sessionId, turnKey,
          }));
        } catch (error) {
          return errorResponse(error, 409);
        }
      }),
    });
  }

  router.route({
    path: "/runner/start",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      traceLog("/runner/start", request);
      const auth = await authenticate(ctx, request);
      if (!auth.ok) return auth.response;
      const { attemptId, epoch } = auth.body;
      if (typeof attemptId !== "string" || typeof epoch !== "number") return json({ error: "invalid_body" }, 400);
      try {
        return json(await ctx.runMutation(internal.runnerControl.recordStage, { credentialId: auth.credential.appId, attemptId, epoch, stage: "work_started", detail: { workerId: auth.credential.workerId } }));
      } catch (error) {
        return errorResponse(error, 409);
      }
    }),
  });

  router.route({
    path: "/runner/session",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      traceLog("/runner/session", request);
      const auth = await authenticate(ctx, request);
      if (!auth.ok) return auth.response;
      const { attemptId, epoch, session } = auth.body;
      if (typeof attemptId !== "string" || typeof epoch !== "number" || !session) return json({ error: "invalid_body" }, 400);
      try {
        return json(await ctx.runMutation(internal.runnerControl.upsertSession, { credentialId: auth.credential.appId, attemptId, epoch, session }));
      } catch (error) {
        return errorResponse(error, 409);
      }
    }),
  });

  router.route({
    path: "/runner/usage",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      traceLog("/runner/usage", request);
      const auth = await authenticateRaw(ctx, request, await request.text(), { ignoreRevocation: true });
      if (!auth.ok) return auth.response;
      const { attemptId, sessionId, tokenUsage, unknownTurns, partialTurns } = auth.body;
      if (typeof attemptId !== "string" || typeof sessionId !== "string" || !tokenUsage
        || typeof unknownTurns !== "number" || typeof partialTurns !== "number") return json({ error: "invalid_body" }, 400);
      try {
        return json(await ctx.runMutation(internal.runnerControl.recordUsage, {
          credentialId: auth.credential.appId, attemptId, sessionId, tokenUsage, unknownTurns, partialTurns,
        }));
      } catch (error) {
        return errorResponse(error, 409);
      }
    }),
  });

  router.route({
    path: "/runner/checkpoint",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      traceLog("/runner/checkpoint", request);
      const auth = await authenticate(ctx, request);
      if (!auth.ok) return auth.response;
      const { attemptId, epoch, checkpoint } = auth.body;
      if (typeof attemptId !== "string" || typeof epoch !== "number" || !checkpoint || typeof checkpoint !== "object"
        || !["primary", "subtask"].includes(String((checkpoint as Record<string, unknown>).role))) {
        return json({ error: "invalid_body" }, 400);
      }
      try {
        return json(await ctx.runMutation(internal.runnerControl.checkpoint, {
          credentialId: auth.credential.appId, attemptId, epoch, checkpoint,
        }));
      } catch (error) {
        return errorResponse(error, 409);
      }
    }),
  });

  router.route({
    path: "/runner/complete",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      traceLog("/runner/complete", request);
      const rawBody = await request.text();
      if (rawBody.length > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);
      let parsed: any;
      try { parsed = rawBody ? JSON.parse(rawBody) : {}; } catch { return json({ error: "invalid_json" }, 400); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "invalid_body" }, 400);
      const credentialId = request.headers.get("x-forksafe-runner");
      if (typeof parsed.operationId === "string" && credentialId) {
        const ack = await ctx.runQuery(internal.runnerControl.getCompletionAck, { operationId: parsed.operationId });
        const bodyHash = await sha256(rawBody);
        if (ack && ack.credentialId === credentialId && ack.attemptId === parsed.attemptId && ack.rawBodySha256 === bodyHash) {
          const replayAuth = await authenticateRaw(ctx, request, rawBody, { ignoreCredentialStatus: true });
          if (!replayAuth.ok) return replayAuth.response;
          if (ack.response?.reason === "fenced" || ack.response?.reason === "stale_epoch") {
            return json({ error: "stale_epoch" }, 409);
          }
          return json(ack.response);
        }
      }
      const auth = await authenticateRaw(ctx, request, rawBody);
      if (!auth.ok) return auth.response;
      const body = auth.body;
      if (typeof body.operationId !== "string" || typeof body.attemptId !== "string" || typeof body.grantId !== "string" || typeof body.epoch !== "number"
        || !["succeeded", "failed", "infra_failed"].includes(body.outcome)) return json({ accepted: false, reason: "invalid_body" }, 400);
      try {
        const result = await ctx.runMutation(internal.runnerControl.complete, {
          credentialId: auth.credential.appId, operationId: body.operationId, attemptId: body.attemptId, grantId: body.grantId,
          rawBodySha256: await sha256(rawBody),
          epoch: body.epoch, outcome: body.outcome, result: body.result ?? {}, sessions: Array.isArray(body.sessions) ? body.sessions : [],
          finishedAtMs: typeof body.finishedAtMs === "number" ? body.finishedAtMs : Date.now(),
        });
        if (result.reason === "fenced" || result.reason === "stale_epoch") return json({ error: "stale_epoch" }, 409);
        return json(result);
      } catch (error) {
        if (isArgumentValidationError(error)) return errorResponse(error, 400);
        const code = errorCode(error);
        console.log("runner/complete rejected", code);
        if (code === "fenced" || code === "stale_epoch") return errorResponse(error, 409);
        return json({ accepted: false, reason: code }, 409);
      }
    }),
  });

  for (const name of TOOL_NAMES) {
    router.route({
      path: `/runner/tools/${name}`,
      method: "POST",
      handler: httpAction(async (ctx, request) => {
        traceLog(`/runner/tools/${name}`, request);
        const auth = await authenticate(ctx, request);
        if (!auth.ok) return auth.response;
        const body = auth.body as Record<string, unknown>;
        const required = ["investigationId", "environmentId", "sessionId", "attemptId", "grantId"];
        if (required.some((key) => typeof body[key] !== "string") || typeof body.epoch !== "number") return json({ error: "tool_context_invalid" }, 400);
        const context = {
          credentialId: auth.credential.appId as string, investigationId: body.investigationId as string, environmentId: body.environmentId as string,
          sessionId: body.sessionId as string, attemptId: body.attemptId as string, grantId: body.grantId as string, epoch: body.epoch as number,
        };
        const callId = typeof body.callId === "string" ? body.callId : undefined;
        try {
          await ctx.runQuery(internal.runnerControl.authorizeTool, context);
          if (name === "request_subtask" && body.subtaskResult !== undefined) {
            if (!callId) return json({ error: "call_id_required" }, 400);
            await ctx.runMutation(internal.agentTools.finishToolCall, { callId, result: body.subtaskResult });
            return json({ ok: true });
          }
          if (["inspect_failure", "read_source", "apply_patch", "fork_candidate", "request_subtask"].includes(name) && !callId) {
            return json({ error: "call_id_required" }, 400);
          }
          let reserved: any;
          if (callId) {
            reserved = await ctx.runMutation(internal.agentTools.reserveToolCall, {
              investigationId: context.investigationId, environmentId: context.environmentId,
              sessionId: context.sessionId, attemptId: context.attemptId, epoch: context.epoch,
              tool: name, callId,
            });
            if (reserved.status === "duplicate") {
              if (name === "request_subtask" && (reserved.result as { status?: string } | null)?.status === "reserved") {
                return json({ status: "retry_later", reason: "call_in_progress" });
              }
              return json(reserved.result ?? { status: "retry_later", reason: "call_in_progress" });
            }
            if (reserved.status === "rejected") return json(reserved.result);
          }
          let result: unknown;
          switch (name) {
            case "inspect_failure":
              result = await ctx.runAction(internal.agentTools.inspectFailure, context);
              break;
            case "read_source":
              result = await ctx.runQuery(internal.agentTools.readSource, { ...context, path: String(body.path ?? ""), ...(typeof body.revisionId === "string" ? { revisionId: body.revisionId } : {}) });
              break;
            case "apply_patch":
              result = await ctx.runAction(internal.agentTools.applyPatch, {
                ...context, diff: String(body.diff ?? ""), expectedHeadRevisionId: typeof body.expectedHeadRevisionId === "string" ? body.expectedHeadRevisionId : null,
                rationale: String(body.rationale ?? ""), basedOnFindings: Array.isArray(body.basedOnFindings) ? body.basedOnFindings.filter((item): item is string => typeof item === "string") : [],
              });
              break;
            case "fork_candidate":
              result = await ctx.runAction(internal.agentTools.forkCandidate, {
                ...context, candidateId: String(body.candidateId ?? ""), rationale: String(body.rationale ?? ""),
                basedOnFindings: Array.isArray(body.basedOnFindings) ? body.basedOnFindings.filter((item): item is string => typeof item === "string") : [],
              });
              break;
            case "request_subtask":
              result = { status: "reserved" };
              break;
            case "run_experiment":
              result = await ctx.runAction(internal.agentTools.runExperiment, {
                ...context, caseId: String(body.caseId ?? ""), seed: Number(body.seed ?? 0),
                ...(typeof body.revisionId === "string" ? { revisionId: body.revisionId } : {}), hypothesis: String(body.hypothesis ?? ""),
                ...(Array.isArray(body.basedOnFindings) ? { basedOnFindings: body.basedOnFindings.filter((item): item is string => typeof item === "string") } : {}),
              });
              break;
            case "propose_controller_revision":
              result = await ctx.runAction(internal.agentTools.proposeRevision, {
                ...context, source: String(body.source ?? ""), rationale: String(body.rationale ?? ""),
                ...(Array.isArray(body.basedOnFindings) ? { basedOnFindings: body.basedOnFindings.filter((item): item is string => typeof item === "string") } : {}),
              });
              break;
            case "submit_candidate":
              result = await ctx.runAction(internal.agentTools.submitCandidate, {
                ...context, revisionId: String(body.revisionId ?? ""), rationale: String(body.rationale ?? ""),
                basedOnFindings: Array.isArray(body.basedOnFindings) ? body.basedOnFindings.filter((item): item is string => typeof item === "string") : [],
              });
              break;
            case "write_finding":
              result = await ctx.runAction(internal.agentTools.writeFinding, {
                ...context, kind: body.kind as any, ...(body.claim ? { claim: body.claim as any } : {}), summary: String(body.summary ?? ""),
                evidence: Array.isArray(body.evidence) ? body.evidence as any[] : [],
              });
              break;
            case "read_findings":
              result = await ctx.runQuery(internal.agentTools.readFindings, { ...context, scope: body.scope === "environment" ? "environment" : "investigation", limit: Number(body.limit ?? 20) });
              await ctx.runMutation(internal.agentTools.recordFindingReads, {
                investigationId: context.investigationId, environmentId: context.environmentId, sessionId: context.sessionId,
                findingIds: Array.isArray((result as any)?.findings) ? (result as any).findings.map((finding: any) => finding.id).filter((id: unknown): id is string => typeof id === "string") : [],
              });
              break;
            case "request_evidence":
              result = await ctx.runQuery(internal.agentTools.requestEvidence, { ...context, query: String(body.query ?? ""), ...(typeof body.experimentId === "string" ? { experimentId: body.experimentId } : {}) });
              break;
          }
          if (callId) await ctx.runMutation(internal.agentTools.finishToolCall, { callId, result });
          return json(result);
        } catch (error) {
          const code = errorCode(error);
          if (isArgumentValidationError(error)) {
            if (callId && name !== "request_subtask") {
              await ctx.runMutation(internal.agentTools.finishToolCall, {
                callId, result: { status: "error", reason: "invalid_request" },
              }).catch(() => undefined);
            }
            return errorResponse(error, 400);
          }
          if (["finding_not_read", "finding_not_in_investigation"].includes(code)) {
            const result = { status: "rejected", reason: code };
            if (callId) await ctx.runMutation(internal.agentTools.finishToolCall, { callId, result }).catch(() => undefined);
            return json(result);
          }
          if (callId && name !== "request_subtask") {
            await ctx.runMutation(internal.agentTools.finishToolCall, {
              callId, result: { status: "error", reason: code },
            }).catch(() => undefined);
          }
          const status = code === "unauthorized" ? 401 : ["fenced", "stale_epoch", "lease_expired", "grant_revoked", "session_mismatch", "investigation_cancelling", "environment_inactive"].includes(code) ? 409 : 500;
          return code === "fenced" || code === "stale_epoch"
            ? json({ error: "stale_epoch" }, 409)
            : json({ error: code }, status);
        }
      }),
    });
  }

  /** Operator upload of code bundles (service token). */
  router.route({
    path: "/bundles/upload",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const header = request.headers.get("authorization");
      try {
        requireServiceToken(header?.startsWith("Bearer ") ? header.slice(7) : undefined);
      } catch {
        return json({ error: "unauthorized" }, 401);
      }
      const key = request.headers.get("x-forksafe-bundle");
      if (key !== "runner" && key !== "simulator" && key !== "baseline_controller") return json({ error: "bundle_key_invalid" }, 400);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > 64 * 1024 * 1024) return json({ error: "bundle_size_invalid" }, 413);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if ((request.headers.get("x-forksafe-sha256") ?? "").toLowerCase() !== sha256) return json({ error: "sha256_mismatch" }, 400);
      const storageId = await ctx.storage.store(new Blob([bytes]));
      const recorded = await ctx.runMutation(internal.bundles.record, { key, storageId, sha256, bytes: bytes.byteLength, note: request.headers.get("x-forksafe-note") ?? undefined });
      if (key === "baseline_controller") {
        const source = new TextDecoder().decode(bytes);
        const artifact = await ctx.runMutation(internal.artifacts.insertCloudArtifact, {
          kind: "controller_source", sha256, bytes: bytes.byteLength, investigationId: "00000000-0000-4000-8000-000000000000", visibility: "internal", storageId,
        });
        await ctx.runMutation(internal.bundles.recordBaselineSource, { controllerSha256: sha256, artifactId: artifact.artifactId, source });
      }
      return json({ key, sha256, bytes: bytes.byteLength, ...recorded });
    }),
  });
}
