import { HumanReview, type ReviewId } from "@forksafe/contracts";
import {
  PanelData,
  PanelRequest,
  RecordReviewResponse,
  ReviewContextRequest,
  StartInvestigationRequest,
  StartInvestigationResponse,
  ReviewRequest,
  validateReview,
  type PanelData as PanelDataType,
  type StartInvestigationResponse as StartResponse,
} from "@forksafe/integrations-atlassian";
import { z } from "zod";
import type { ForkSafeBackend } from "./backend.js";

export type ForgeContext = {
  accountId?: string | null;
  extension?: {
    issue?: { key?: string; id?: string };
    project?: { key?: string };
  };
};

export type HandlerResult<T> =
  | { ok: true; mode: "live" | "local" | "fixture" | "blocked" | "not_implemented"; data: T }
  | { ok: false; code: string; message: string };

type HandlerRequest = { payload: unknown; context: ForgeContext };

const StartPayload = z
  .object({
    title: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).max(200).optional(),
    ),
    requestedEnvironments: z.coerce.number().int().min(1).max(10).optional(),
    confluencePageId: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().regex(/^\d+$/).optional(),
    ),
  })
  .strict();

export function createHandlers(
  backend: ForkSafeBackend,
  {
    now = Date.now,
    newId = () => globalThis.crypto.randomUUID(),
  }: { now?: () => number; newId?: () => string } = {},
): {
  getPanel(req: HandlerRequest): Promise<HandlerResult<PanelDataType>>;
  startInvestigation(
    req: HandlerRequest,
  ): Promise<HandlerResult<StartResponse>>;
  submitReview(
    req: HandlerRequest,
  ): Promise<
    HandlerResult<{ reviewId: string; recorded: boolean }>
  >;
} {
  return {
    async getPanel({ context }) {
      const issue = issueContext(context);
      if (!issue) return noIssueContext();
      try {
        const data = PanelData.parse(await backend.getPanel(PanelRequest.parse(issue)));
        return { ok: true, mode: data.mode, data };
      } catch {
        return backendFailure();
      }
    },

    async startInvestigation({ payload, context }) {
      const issue = issueContext(context);
      if (!issue) return noIssueContext();
      let form: z.infer<typeof StartPayload>;
      try {
        form = StartPayload.parse(payload ?? {});
      } catch {
        return invalidRequest();
      }
      try {
        const request = StartInvestigationRequest.parse({
          ...issue,
          title: form.title ?? `${issue.issueKey} investigation`,
          requestedEnvironments: form.requestedEnvironments ?? 3,
          ...(form.confluencePageId === undefined
            ? {}
            : { confluencePageId: form.confluencePageId }),
        });
        const data = StartInvestigationResponse.parse(
          await backend.startInvestigation(request),
        );
        return { ok: true, mode: data.mode, data };
      } catch (error) {
        return error instanceof z.ZodError ? invalidRequest() : backendFailure();
      }
    },

    async submitReview({ payload, context }) {
      if (!context.accountId) {
        return {
          ok: false,
          code: "unauthenticated",
          message: "Sign in to Jira before submitting a review.",
        };
      }
      const issue = issueContext(context);
      if (!issue) return noIssueContext();
      let request: z.infer<typeof ReviewRequest>;
      try {
        request = ReviewRequest.parse(payload);
      } catch {
        return invalidRequest();
      }
      try {
        const reviewContext = await backend.getReviewContext(
          ReviewContextRequest.parse({
            investigationId: request.investigationId,
            candidateId: request.candidateId,
            evaluationId: request.evaluationId,
          }),
        );
        const validated = validateReview(request, reviewContext, {
          reviewerIdentity: `atlassian:${context.accountId}`,
          reviewId: newId() as ReviewId,
          nowMs: now(),
          jiraIssueKey: issue.issueKey,
        });
        if (!validated.ok) {
          return {
            ok: false,
            code: validated.code,
            message: validated.message,
          };
        }
        const recorded = RecordReviewResponse.parse(
          await backend.recordReview({ review: HumanReview.parse(validated.review) }),
        );
        return {
          ok: true,
          mode: backend.mode,
          data: { reviewId: recorded.reviewId, recorded: recorded.recorded },
        };
      } catch {
        return backendFailure();
      }
    },
  };
}

function issueContext(
  context: ForgeContext,
):
  | { issueKey: string; issueId: string; projectKey: string }
  | undefined {
  const issueKey = context.extension?.issue?.key;
  const issueId = context.extension?.issue?.id;
  const projectKey = context.extension?.project?.key;
  if (!issueKey || !issueId || !projectKey) return undefined;
  return { issueKey, issueId, projectKey };
}

function noIssueContext(): HandlerResult<never> {
  return {
    ok: false,
    code: "no_issue_context",
    message: "Open this panel from a Jira issue.",
  };
}

function invalidRequest(): HandlerResult<never> {
  return {
    ok: false,
    code: "invalid_request",
    message: "Check the submitted values and try again.",
  };
}

function backendFailure(): HandlerResult<never> {
  return {
    ok: false,
    code: "backend_error",
    message: "The ForkSafe backend request could not be completed.",
  };
}
