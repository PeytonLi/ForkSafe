import {
  CandidateEvaluation,
  Investigation,
  InvestigationEnvironment,
  OperationId,
} from "@forksafe/contracts";
import { AtlassianHttpError, JiraClient, JiraSyncInput, basicAuthTransport, syncInvestigationToJira } from "../../packages/integrations/atlassian/src/index.js";
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { ZodError } from "zod";
import { internal } from "../_generated/api.js";
import { internalAction, internalMutation, internalQuery } from "../_generated/server.js";
import { SpacetimeClient, SpacetimeRejected, SpacetimeUnavailable } from "./spacetime.js";

type JiraMode = "live" | "blocked" | "not_implemented";
type DispatchResult = { delivered: boolean; mode: JiraMode; reason?: string };
type Snapshot = { investigation: Investigation; environments: InvestigationEnvironment[] } | null;

const getInvestigationRef = makeFunctionReference<"query">("dispatchers/jira.getInvestigation");
const UUID_NAMESPACE = "f8a11234-51cc-5db4-b570-7f1e480da7b7";

export async function operationIdForIdempotencyKey(key: string): Promise<string> {
  const namespace = uuidBytes(UUID_NAMESPACE);
  const name = new TextEncoder().encode(key);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function classifyJiraFailure(error: unknown): { permanent: boolean; code: string } {
  if (error instanceof SpacetimeRejected) return { permanent: true, code: `spacetime_${safeCode(error.code)}` };
  if (error instanceof SpacetimeUnavailable) return { permanent: false, code: "spacetime_unavailable" };
  if (error instanceof ZodError) return { permanent: true, code: "jira_invalid_payload" };
  if (error instanceof TypeError) return { permanent: true, code: "jira_invalid_payload" };
  if (error instanceof AtlassianHttpError) {
    if (error.status === 400 || error.status === 404) return { permanent: true, code: `jira_http_${error.status}` };
    return { permanent: false, code: error.status === 401 || error.status === 403 ? "jira_auth" : error.status === 429 ? "jira_rate_limited" : "jira_unavailable" };
  }
  return { permanent: false, code: "jira_unavailable" };
}

export async function deliverJiraPayload(
  payload: unknown,
  deps: {
    client: JiraClient;
    spacetime: Pick<SpacetimeClient, "getReview" | "listCandidates" | "listEvaluations" | "findingsCount">;
    snapshot: (args: { id?: string; jiraIssueKey?: string }) => Promise<Snapshot>;
    projectKey: string;
    siteUrl: string;
    webUrl?: string;
    readyStatuses?: string[];
  },
): Promise<{ input: ReturnType<typeof JiraSyncInput.parse>; result: unknown } | { remoteLinked: true }> {
  if (!payload || typeof payload !== "object") throw new TypeError("jira_payload_invalid");
  const value = payload as Record<string, unknown>;
  if (value.destination === "confluence_link" || (typeof value.pageId === "string" && typeof value.investigationId === "string" && !value.investigation)) {
    const investigationId = String(value.investigationId ?? "");
    const pageId = String(value.pageId ?? "");
    if (!/^\d+$/.test(pageId)) throw new TypeError("confluence_page_id_invalid");
    const snapshot = await deps.snapshot({ id: investigationId });
    if (!snapshot) throw new TypeError("investigation_missing");
    const label = `forksafe-inv-${snapshot.investigation.id}`;
    let issueKey = snapshot.investigation.jiraIssueKey;
    if (!issueKey) {
      const found = await deps.client.searchJql(
        `project = "${deps.projectKey}" AND labels = "${label}" ORDER BY created ASC`,
        ["status", "labels"],
      );
      issueKey = found[0]?.key;
    }
    if (!issueKey) throw new AtlassianHttpError(404, "GET", "/rest/api/3/issue", "investigation issue not found");
    const pageUrl = new URL(`/wiki/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`, deps.siteUrl).toString();
    await deps.client.upsertRemoteLink(issueKey, {
      globalId: `forksafe:confluence:${investigationId}:${pageId}`,
      url: pageUrl,
      title: "ForkSafe requirements",
      summary: `Confluence page ${pageId}`,
    });
    return { remoteLinked: true };
  }

  let investigationId: string;
  let idempotencyKey: string | undefined;
  const explicit = JiraSyncInput.safeParse(payload);
  if (value.kind === "review" && typeof value.id === "string") {
    const review = await deps.spacetime.getReview(value.id);
    if (!review) throw new TypeError("review_missing");
    investigationId = review.investigationId;
    idempotencyKey = jiraIdempotencyKey(value);
  } else if (explicit.success) {
    investigationId = explicit.data.investigation.id;
    idempotencyKey = typeof value.idempotencyKey === "string"
      ? value.idempotencyKey
      : `jira_sync:${investigationId}`;
  } else if (value.kind === "review" && value.record && typeof value.record === "object") {
    const record = value.record as { id?: unknown; investigationId?: unknown };
    if (typeof record.id !== "string" || typeof record.investigationId !== "string") throw new TypeError("review_payload_invalid");
    investigationId = record.investigationId;
    idempotencyKey = jiraIdempotencyKey({ kind: "review", record });
  } else {
    throw new TypeError("jira_payload_invalid");
  }

  const snapshot = await deps.snapshot({ id: investigationId });
  if (!snapshot) throw new TypeError("investigation_missing");
  const [candidates, evaluations, findingsCount] = await Promise.all([
    deps.spacetime.listCandidates(investigationId),
    deps.spacetime.listEvaluations(investigationId),
    deps.spacetime.findingsCount(investigationId),
  ]);
  const bestEvaluation = selectBestEvaluation(candidates, evaluations);
    const statuses = deps.readyStatuses?.filter(Boolean);
  const input = JiraSyncInput.parse({
    operationId: OperationId.parse(await operationIdForIdempotencyKey(idempotencyKey!)),
    projectKey: deps.projectKey,
    investigation: snapshot.investigation,
    summary: {
      activeEnvironments: snapshot.environments.filter((environment) => environment.state === "active").length,
      findingsCount,
      candidatesCount: candidates.length,
      ...(bestEvaluation ? { bestEvaluation } : {}),
    },
    ...(deps.webUrl ? { investigationUrl: new URL(`/investigations/${investigationId}`, deps.webUrl).toString() } : {}),
    ...(statuses?.length ? { workflow: { readyForReview: { statusNames: statuses } } } : {}),
  });
  return { input, result: await syncInvestigationToJira(deps.client, input) };
}

function selectBestEvaluation(
  candidates: Array<{ id: string; controllerSha256: string }>,
  evaluations: CandidateEvaluation[],
) {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const choices = evaluations.flatMap((evaluation) => {
    const candidate = candidatesById.get(evaluation.candidateId);
    if (!candidate) return [];
    return [{
      evaluation,
      candidate,
      passedCases: evaluation.cases.filter((item) => item.status === "passed").length,
    }];
  });
  choices.sort((left, right) =>
    Number(right.evaluation.allRequiredPassed) - Number(left.evaluation.allRequiredPassed)
    || right.passedCases - left.passedCases
    || right.evaluation.createdAtMs - left.evaluation.createdAtMs,
  );
  const best = choices[0];
  return best ? {
    candidateId: best.candidate.id,
    controllerSha256: best.candidate.controllerSha256,
    status: best.evaluation.status,
    allRequiredPassed: best.evaluation.allRequiredPassed,
    passedCases: best.passedCases,
    totalCases: best.evaluation.cases.length,
  } : undefined;
}

function uuidBytes(value: string): Uint8Array {
  const hex = value.replace(/-/g, "");
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function safeCode(value: string): string {
  return /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : "rejected";
}

export const getInvestigation = internalQuery({
  args: { id: v.optional(v.string()), jiraIssueKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Snapshot> => {
    const row = args.id
      ? await ctx.db.query("investigations").withIndex("by_appId", (q) => q.eq("appId", args.id!)).unique()
      : (await ctx.db.query("investigations").collect())
          .filter((item) => item.jiraIssueKey === args.jiraIssueKey)
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0] ?? null;
    if (!row) return null;
    const investigation = Investigation.parse({
      id: row.appId,
      state: row.state,
      title: row.title,
      baselineCase: row.baselineCase,
      baselineExperimentId: row.baselineExperimentId,
      ...(row.jiraIssueKey ? { jiraIssueKey: row.jiraIssueKey } : {}),
      ...(Reflect.get(row, "confluencePageId") ? { confluencePageId: Reflect.get(row, "confluencePageId") } : {}),
      requestedEnvironments: row.requestedEnvironments,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
    });
    const environmentRows = await ctx.db.query("environments")
      .withIndex("by_investigation", (q) => q.eq("investigationId", row.appId))
      .collect();
    const environments = environmentRows.map((environment) => InvestigationEnvironment.parse({
      id: environment.appId,
      investigationId: environment.investigationId,
      index: environment.index,
      state: environment.state,
      budgets: environment.budgets,
      ...(environment.startedAtMs === undefined ? {} : { startedAtMs: environment.startedAtMs }),
      ...(environment.closedAtMs === undefined ? {} : { closedAtMs: environment.closedAtMs }),
    }));
    return { investigation, environments };
  },
});

export const deadLetter = internalMutation({
  args: { idempotencyKey: v.string(), errorCode: v.string() },
  handler: async (ctx, args) => {
    const entry = await ctx.db.query("outbox")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (!entry || entry.status === "delivered") return { updated: false };
    if (entry.status === "pending") await ctx.db.patch(entry._id, { status: "dead", lastError: args.errorCode });
    return { updated: true };
  },
});

export const dispatch = internalAction({
  args: { payload: v.any() },
  handler: async (ctx, args): Promise<DispatchResult> => {
    const env = process.env;
    if (env.ATLASSIAN_MODE !== "cloud" || !env.ATLASSIAN_SITE_URL || !env.ATLASSIAN_EMAIL || !env.ATLASSIAN_API_TOKEN || !env.ATLASSIAN_PROJECT_KEY) {
      return { delivered: false, mode: "blocked", reason: "atlassian_not_configured" };
    }
    const client = new JiraClient(basicAuthTransport({
      siteUrl: env.ATLASSIAN_SITE_URL,
      email: env.ATLASSIAN_EMAIL,
      apiToken: env.ATLASSIAN_API_TOKEN,
    }));
    const bridgeToken = await ctx.runAction(internal.bridge.sharedBridgeToken, {});
    const spacetime = new SpacetimeClient(bridgeToken ? { ...process.env, SPACETIMEDB_BRIDGE_TOKEN: bridgeToken } : process.env);
    const snapshot = (query: { id?: string; jiraIssueKey?: string }) =>
      ctx.runQuery(getInvestigationRef, query);
    const key = jiraIdempotencyKey(args.payload);
    try {
      if (!key) throw new TypeError("jira_idempotency_key_missing");
      await deliverJiraPayload(args.payload, {
        client,
        spacetime,
        snapshot,
        projectKey: env.ATLASSIAN_PROJECT_KEY,
        siteUrl: env.ATLASSIAN_SITE_URL,
        ...(env.FORKSAFE_WEB_URL ? { webUrl: env.FORKSAFE_WEB_URL } : {}),
        ...(env.JIRA_READY_FOR_REVIEW_STATUSES ? {
          readyStatuses: env.JIRA_READY_FOR_REVIEW_STATUSES.split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
        } : {}),
      });
      return { delivered: true, mode: "live" };
    } catch (error) {
      const failure = classifyJiraFailure(error);
      if (failure.permanent && key) {
        await ctx.runMutation(internal.dispatchers.jira.deadLetter, {
          idempotencyKey: key,
          errorCode: failure.code,
        }).catch(() => ({ updated: false }));
        return { delivered: false, mode: "live", reason: `permanent:${failure.code}` };
      }
      return { delivered: false, mode: "live", reason: failure.code };
    }
  },
});

export function jiraIdempotencyKey(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  if (typeof value.idempotencyKey === "string") return value.idempotencyKey;
  if (value.kind === "review" && typeof value.id === "string") return `review:${value.id}:jira_sync`;
  if (value.kind === "review" && value.record && typeof value.record === "object" && typeof (value.record as { id?: unknown }).id === "string") {
    return `review:${(value.record as { id: string }).id}:jira_sync`;
  }
  if (typeof value.investigationId === "string" && typeof value.pageId === "string") {
    return `confluence_link:${value.investigationId}:${value.pageId}`;
  }
  const investigation = value.investigation as { id?: unknown } | undefined;
  if (typeof investigation?.id === "string") return `jira_sync:${investigation.id}`;
  if (typeof value.investigationId === "string") return `jira_sync:${value.investigationId}`;
  return undefined;
}
