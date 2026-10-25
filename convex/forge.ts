import {
  IntegrationReadiness,
  describeScene,
  type CandidateEvaluation,
  type ControllerCandidate,
  type HumanReview,
  type Investigation,
} from "@forksafe/contracts";
import {
  FORGE_BACKEND_PATHS,
  PanelRequest,
  RecordReviewRequest,
  RecordReviewResponse,
  ReviewContextRequest,
  StartInvestigationRequest,
  StartInvestigationResponse,
  ConfluenceClient,
  ReviewRequest,
  basicAuthTransport,
  extractRequirements,
  validateReview,
  type ForgeInvocationContext,
} from "../packages/integrations/atlassian/src/index.js";
import { api, internal } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import type { HttpRouter } from "convex/server";
import {
  authenticateForgeRequest,
  authorizeForgeContext,
  authorizeReviewIdentity,
  sameStoredReview,
} from "./forgeLogic.js";
import { SpacetimeClient, SpacetimeUnavailable, SpacetimeRejected } from "./dispatchers/spacetime.js";
import type { ZodType } from "zod";
import { FORGE_FEATURE_PATHS, MoreInvestigationRequest, MoreInvestigationResponse, PanelData, ReviewContext as ReviewContextSchema } from "./forgeProtocolExt.js";
import { appId as newAppId } from "./lib/validators.js";

type ForgeRouteDependencies = {
  verifyToken?: (token: string, appId: string) => Promise<ForgeInvocationContext>;
  spacetime?: () => SpacetimeClient;
  now?: () => number;
  newId?: () => string;
};

const getInvestigationRef = internal.dispatchers.jira.getInvestigation;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function registerForgeRoutes(http: HttpRouter, dependencies: ForgeRouteDependencies = {}): void {
  http.route({
    path: FORGE_BACKEND_PATHS.panel,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authenticate(request, dependencies);
      if (!auth.ok) return auth.response;
      const parsed = await requestBody(request, PanelRequest);
      if (!parsed.ok) return parsed.response;
      const authorization = authorizeForgeContext(auth.context, parsed.data, process.env.ATLASSIAN_PROJECT_KEY);
      if (!authorization.ok) return json({ error: authorization.error }, authorization.status);
      const investigation = await ctx.runQuery(getInvestigationRef, { jiraIssueKey: parsed.data.issueKey }) as {
        investigation: Record<string, any>;
        environments: Array<Record<string, any>>;
      } | null;
      if (!investigation) return json({ error: "investigation_not_found" }, 404);

      try {
        const evidence = await ctx.runQuery(internal.forgeData.evidence, { investigationId: investigation.investigation.id });
        const checkedAtMs = (dependencies.now ?? Date.now)();
        const health = await ctx.runQuery(api.health.get, {});
        const spacetimedb = (dependencies.spacetime ?? (() => new SpacetimeClient()))();
        let candidates: ControllerCandidate[] = [];
        let evaluations: CandidateEvaluation[] = [];
        let reviews: HumanReview[] = [];
        let findingsCount = 0;
        let canonicalMode: "live" | "blocked" = investigation ? "live" : "blocked";
        if (investigation) {
          try {
            [candidates, evaluations, reviews, findingsCount] = await Promise.all([
              spacetimedb.listCandidates(investigation.investigation.id),
              spacetimedb.listEvaluations(investigation.investigation.id),
              spacetimedb.listReviews(investigation.investigation.id),
              spacetimedb.findingsCount(investigation.investigation.id),
            ]);
          } catch {
            canonicalMode = "blocked";
          }
        }

        const confluencePageId = process.env.FORKSAFE_CONFLUENCE_REQUIREMENTS_PAGE_ID;
        let requirements: {
          pageId: string;
          version: number;
          title: string;
          checkedRules: number;
          humanReviewItems: number;
        } | null = null;
        let confluenceMode: "live" | "blocked" = "blocked";
        if (confluencePageId && atlassianConfigured()) {
          try {
            const client = new ConfluenceClient(basicAuthTransport({
              siteUrl: process.env.ATLASSIAN_SITE_URL!,
              email: process.env.ATLASSIAN_EMAIL!,
              apiToken: process.env.ATLASSIAN_API_TOKEN!,
            }));
            const page = await client.getPage(confluencePageId);
            const extracted = extractRequirements(page, checkedAtMs);
            requirements = {
              pageId: page.pageId,
              version: page.version,
              title: page.title,
              checkedRules: extracted.items.filter((item) => item.kind === "checked_rule").length,
              humanReviewItems: extracted.items.filter((item) => item.kind === "human_review").length,
            };
            confluenceMode = "live";
          } catch {
            requirements = null;
          }
        }

        const candidateData = candidates.map((candidate) => {
          const evaluation = bestEvaluationFor(candidate.id, evaluations);
          const uncommittedSuites = [...new Set((evidence.uncommittedEvaluations ?? [])
            .filter((item) => item.candidateId === candidate.id)
            .map((item) => item.suite))];
          return {
            candidate: {
              id: candidate.id,
              environmentId: candidate.environmentId,
              status: candidate.status,
              controllerSha256: candidate.controllerSha256,
              changedFunctions: candidate.changedFunctions,
              submittedAtMs: candidate.submittedAtMs,
            },
            evaluation: evaluation ? {
              id: evaluation.id,
              suite: evaluation.suite,
              status: evaluation.status,
              allRequiredPassed: evaluation.allRequiredPassed,
              ...(evaluation.medianCompletionTimeSec === undefined ? {} : { medianCompletionTimeSec: evaluation.medianCompletionTimeSec }),
            } : null,
            passedCases: evaluation?.cases.filter((item) => item.status === "passed").length ?? 0,
            totalCases: evaluation?.cases.length ?? 0,
            suites: suiteSummaries(candidate.id, evaluations),
            ...(uncommittedSuites.length ? { uncommittedSuites } : {}),
          };
        });
        const underReview = investigation?.investigation.state === "awaiting_review"
          ? candidateData.flatMap((item) => item.evaluation?.status === "passed" && item.evaluation.allRequiredPassed
              ? [{ candidateId: item.candidate.id, evaluationId: item.evaluation.id, controllerSha256: item.candidate.controllerSha256 }]
              : [])[0] ?? null
          : null;
        const jiraReady = atlassianConfigured();
        const readiness = [
          ...(health.readiness as Array<Record<string, unknown>>),
          ready("spacetimedb", canonicalMode, canonicalMode === "live" ? "Canonical records loaded" : "Canonical records unavailable", checkedAtMs),
          ready("elastic", configuredElastic() ? "live" : "blocked", configuredElastic() ? "Projection configured" : "Projection not configured", checkedAtMs),
          ready("atlassian_jira", jiraReady ? "live" : "blocked", jiraReady ? "Jira credentials configured" : "Jira not configured", checkedAtMs),
          ready("atlassian_confluence", confluenceMode, confluenceMode === "live" ? "Requirements loaded" : "Requirements unavailable", checkedAtMs),
        ];
        const response = PanelData.parse({
          mode: canonicalMode,
          issue: { key: parsed.data.issueKey, id: parsed.data.issueId },
          readiness,
          investigation: investigation ? {
            id: investigation.investigation.id,
            state: investigation.investigation.state,
            title: investigation.investigation.title,
            requestedEnvironments: investigation.investigation.requestedEnvironments,
            ...(investigation.investigation.confluencePageId ? { confluencePageId: investigation.investigation.confluencePageId } : {}),
            updatedAtMs: investigation.investigation.updatedAtMs,
          } : null,
          environments: investigation ? investigation.environments.map((environment) => ({
            id: environment.id,
            index: environment.index,
            state: environment.state,
          })) : [],
          findingsCount,
          findings: evidence.findings,
          candidates: candidateData,
          underReview,
          reviews: reviews.map((review) => ({
            id: review.id,
            candidateId: review.candidateId,
            controllerSha256: review.controllerSha256,
            decision: review.decision,
            reviewerIdentity: review.reviewerIdentity,
            createdAtMs: review.createdAtMs,
          })),
          requirements,
          links: {
            ...webLinks(investigation.investigation.id),
            ...(evidence.evidencePackUrl ? { evidencePackUrl: evidence.evidencePackUrl } : {}),
          },
          fetchedAtMs: checkedAtMs,
        });
        return json(response);
      } catch {
        return json({ error: "forge_backend_unavailable" }, 503);
      }
    }),
  });

  http.route({
    path: FORGE_BACKEND_PATHS.start,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authenticate(request, dependencies);
      if (!auth.ok) return auth.response;
      const parsed = await requestBody(request, StartInvestigationRequest);
      if (!parsed.ok) return parsed.response;
      const authorization = authorizeForgeContext(auth.context, parsed.data, process.env.ATLASSIAN_PROJECT_KEY);
      if (!authorization.ok) return json({ error: authorization.error }, authorization.status);
      const serviceToken = process.env.INTEGRATION_SHARED_SECRET;
      if (!serviceToken) return json({ error: "forge_not_configured" }, 503);
      const described = describeScene(parsed.data.title);
      const baselineCase = described.status === "matched"
        ? {
            caseId: (dependencies.newId ?? newAppId)(),
            suite: "original" as const,
            seed: 1,
            sceneOverrides: described.overrides,
            taskFamily: described.taskFamily,
            description: described.explanation,
          }
        : undefined;
      try {
        const created = await ctx.runMutation(api.investigations.create, {
          title: parsed.data.title,
          requestedEnvironments: parsed.data.requestedEnvironments,
          jiraIssueKey: parsed.data.issueKey,
          ...(baselineCase ? { baselineCase } : {}),
          idempotencyKey: `forge:${auth.context.installationId}:${parsed.data.issueId}`,
          serviceToken,
        });
        const snapshot = await ctx.runQuery(getInvestigationRef, { id: created.investigationId }) as {
          investigation: { state: string };
        } | null;
        if (!snapshot) return json({ error: "investigation_not_found" }, 404);
        const response = StartInvestigationResponse.parse({
          investigationId: created.investigationId,
          state: snapshot.investigation.state,
          mode: "live",
        });
        return json(response);
      } catch {
        return json({ error: "forge_backend_unavailable" }, 503);
      }
    }),
  });

  http.route({
    path: FORGE_BACKEND_PATHS.reviewContext,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authenticate(request, dependencies);
      if (!auth.ok) return auth.response;
      const parsed = await requestBody(request, ReviewContextRequest);
      if (!parsed.ok) return parsed.response;
      const projectAuthorization = authorizeForgeContext(auth.context, parsed.data, process.env.ATLASSIAN_PROJECT_KEY, undefined, { skipIssueCheck: true });
      if (!projectAuthorization.ok) return json({ error: projectAuthorization.error }, projectAuthorization.status);
        const snapshot = await ctx.runQuery(getInvestigationRef, { id: parsed.data.investigationId }) as {
          investigation: Investigation;
        } | null;
      if (!snapshot) return json({ error: "investigation_not_found" }, 404);
      const authorization = authorizeForgeContext(auth.context, parsed.data, process.env.ATLASSIAN_PROJECT_KEY, snapshot.investigation);
      if (!authorization.ok) return json({ error: authorization.error }, authorization.status);
      try {
        const spacetime = (dependencies.spacetime ?? (() => new SpacetimeClient()))();
        const [candidate, evaluation] = await Promise.all([
          spacetime.getCandidate(parsed.data.candidateId),
          spacetime.getEvaluation(parsed.data.evaluationId),
        ]);
        if (!candidate || !evaluation) return json({ error: "review_context_not_found" }, 404);
        if (candidate.investigationId !== snapshot.investigation.id || evaluation.investigationId !== snapshot.investigation.id || evaluation.candidateId !== candidate.id) return json({ error: "forbidden" }, 403);
        const evidence = await ctx.runQuery(internal.forgeData.evidence, { investigationId: snapshot.investigation.id });
        const response = ReviewContextSchema.parse({
          investigation: snapshot.investigation,
          candidate,
          evaluation,
          ...(evidence.evidencePackUrl ? { evidencePackUrl: evidence.evidencePackUrl } : {}),
        });
        return json(response);
      } catch {
        return json({ error: "forge_backend_unavailable" }, 503);
      }
    }),
  });

  http.route({
    path: FORGE_BACKEND_PATHS.review,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authenticate(request, dependencies);
      if (!auth.ok) return auth.response;
      const parsed = await requestBody(request, RecordReviewRequest);
      if (!parsed.ok) return parsed.response;
      const projectAuthorization = authorizeForgeContext(auth.context, parsed.data, process.env.ATLASSIAN_PROJECT_KEY, undefined, { skipIssueCheck: true });
      if (!projectAuthorization.ok) return json({ error: projectAuthorization.error }, projectAuthorization.status);
      const identity = authorizeReviewIdentity(auth.context, parsed.data.review);
      if (!identity.ok) return json({ error: identity.error }, identity.status);
      const snapshot = await ctx.runQuery(getInvestigationRef, { id: parsed.data.review.investigationId }) as {
        investigation: Investigation;
      } | null;
      if (!snapshot) return json({ error: "investigation_not_found" }, 404);
      const authorization = authorizeForgeContext(auth.context, parsed.data, process.env.ATLASSIAN_PROJECT_KEY, snapshot.investigation);
      if (!authorization.ok) return json({ error: authorization.error }, authorization.status);
      try {
        const spacetime = (dependencies.spacetime ?? (() => new SpacetimeClient()))();
        const [candidate, evaluation] = await Promise.all([
          spacetime.getCandidate(parsed.data.review.candidateId),
          spacetime.getEvaluation(parsed.data.review.evaluationId),
        ]);
        if (!candidate || !evaluation) return json({ error: "review_context_not_found" }, 404);
        const reviewRequest = ReviewRequest.parse({
          investigationId: parsed.data.review.investigationId,
          candidateId: parsed.data.review.candidateId,
          evaluationId: parsed.data.review.evaluationId,
          controllerSha256: parsed.data.review.controllerSha256,
          decision: parsed.data.review.decision,
          ...(parsed.data.review.notes === undefined ? {} : { notes: parsed.data.review.notes }),
        });
        const validated = validateReview(reviewRequest, {
          investigation: snapshot.investigation,
          candidate,
          evaluation,
        }, {
          reviewerIdentity: identity.reviewerIdentity,
          reviewId: parsed.data.review.id,
          nowMs: (dependencies.now ?? Date.now)(),
          ...(snapshot.investigation.jiraIssueKey ? { jiraIssueKey: snapshot.investigation.jiraIssueKey } : {}),
        });
        if (!validated.ok) return json({ error: validated.code }, 409);

        try {
          await spacetime.callReducer("record_review", {
            id: validated.review.id,
            investigationId: validated.review.investigationId,
            candidateId: validated.review.candidateId,
            evaluationId: validated.review.evaluationId,
            controllerSha256: validated.review.controllerSha256,
            decision: validated.review.decision,
            reviewerIdentity: validated.review.reviewerIdentity,
            notes: validated.review.notes ?? null,
            jiraIssueKey: validated.review.jiraIssueKey ?? null,
          });
        } catch (error) {
          if (!(error instanceof SpacetimeRejected) || error.code !== "duplicate_id") throw error;
          const prior = await spacetime.getReview(validated.review.id);
          if (!prior || !sameStoredReview(prior, validated.review)) {
            return json({ error: "review_conflict" }, 409);
          }
        }
        return json(RecordReviewResponse.parse({ reviewId: validated.review.id, recorded: true }));
      } catch (error) {
        if (error instanceof SpacetimeUnavailable) return json({ error: "forge_backend_unavailable" }, 503);
        if (error instanceof SpacetimeRejected) return json({ error: "review_conflict" }, 409);
        return json({ error: "forge_backend_unavailable" }, 503);
      }
    }),
  });

  http.route({
    path: FORGE_FEATURE_PATHS.requests,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authenticate(request, dependencies);
      if (!auth.ok) return auth.response;
      const parsed = await requestBody(request, MoreInvestigationRequest);
      if (!parsed.ok) return parsed.response;
      const authorization = authorizeForgeContext(auth.context, parsed.data, process.env.ATLASSIAN_PROJECT_KEY);
      if (!authorization.ok) return json({ error: authorization.error }, authorization.status);
      const identity = authorizeReviewIdentity(auth.context, { reviewerIdentity: parsed.data.requestedBy });
      if (!identity.ok) return json({ error: identity.error }, identity.status);
      try {
        const snapshot = await ctx.runQuery(getInvestigationRef, { id: parsed.data.investigationId }) as { investigation: Investigation } | null;
        if (!snapshot) return json({ error: "investigation_not_found" }, 404);
        if (snapshot.investigation.jiraIssueKey !== parsed.data.issueKey) return json({ error: "forbidden" }, 403);
        const parentAuthorization = authorizeForgeContext(auth.context, parsed.data, process.env.ATLASSIAN_PROJECT_KEY, snapshot.investigation);
        if (!parentAuthorization.ok) return json({ error: parentAuthorization.error }, parentAuthorization.status);
        const result = await ctx.runMutation(internal.investigations.requestMoreFromForge, {
          request: parsed.data, installationId: auth.context.installationId, requestedBy: identity.reviewerIdentity,
        });
        if (result.error) return json({ error: result.error }, result.error === "request_conflict" ? 409 : result.error === "forbidden" ? 403 : 404);
        return json(MoreInvestigationResponse.parse(result.result));
      } catch {
        return json({ error: "forge_backend_unavailable" }, 503);
      }
    }),
  });
}

export function suiteSummaries(candidateId: string, evaluations: CandidateEvaluation[]) {
  return (["public", "withheld"] as const).flatMap((suite) => {
    const evaluation = evaluations.filter((e) => e.candidateId === candidateId && e.suite === suite).sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    if (!evaluation) return [];
    const failed = evaluation.cases.filter((item) => item.status === "failed" || item.status === "invalid");
    return [{
      evaluationId: evaluation.id, suite, status: evaluation.status, allRequiredPassed: evaluation.allRequiredPassed,
      passedCases: evaluation.cases.filter((item) => item.status === "passed").length, failedCases: failed.length, totalCases: evaluation.cases.length,
      ...(suite === "public" ? { failedCaseIds: failed.slice(0, 50).map((item) => item.caseId) } : {}),
    }];
  });
}

export function webLinks(investigationId: string) {
  try {
    const url = new URL(process.env.FORKSAFE_WEB_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password) return {};
    url.hash = `/investigations/${investigationId}/capture`;
    return { webAppUrl: url.toString(), investigationUrl: url.toString() };
  } catch { return {}; }
}

async function authenticate(
  request: Request,
  dependencies: ForgeRouteDependencies,
): Promise<{ ok: true; context: ForgeInvocationContext } | { ok: false; response: Response }> {
  const result = await authenticateForgeRequest(
    request.headers.get("authorization") ?? undefined,
    process.env,
    dependencies.verifyToken,
  );
  if (!result.ok) return { ok: false, response: json({ error: result.error }, result.status) };
  return { ok: true, context: result.context };
}

async function requestBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  try {
    return { ok: true, data: schema.parse(await request.json()) };
  } catch {
    return { ok: false, response: json({ error: "invalid_request" }, 400) };
  }
}

function bestEvaluationFor(candidateId: string, evaluations: CandidateEvaluation[]) {
  return evaluations.filter((evaluation) => evaluation.candidateId === candidateId)
    .sort((left, right) =>
      Number(right.allRequiredPassed) - Number(left.allRequiredPassed)
      || Number(right.status === "passed") - Number(left.status === "passed")
      || right.createdAtMs - left.createdAtMs,
    )[0];
}

function ready(
  name: "spacetimedb" | "elastic" | "atlassian_jira" | "atlassian_confluence",
  mode: "live" | "blocked",
  detail: string,
  checkedAtMs: number,
) {
  return IntegrationReadiness.parse({ name, mode, detail, checkedAtMs });
}

function atlassianConfigured(): boolean {
  return process.env.ATLASSIAN_MODE === "cloud"
    && Boolean(process.env.ATLASSIAN_SITE_URL)
    && Boolean(process.env.ATLASSIAN_EMAIL)
    && Boolean(process.env.ATLASSIAN_API_TOKEN)
    && Boolean(process.env.ATLASSIAN_PROJECT_KEY);
}

function configuredElastic(): boolean {
  return process.env.ELASTIC_MODE === "cloud"
    && Boolean(process.env.ELASTICSEARCH_URL)
    && Boolean(process.env.ELASTICSEARCH_API_KEY);
}
