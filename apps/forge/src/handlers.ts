import { createHash } from "node:crypto";
import { HumanReview, type ReviewId } from "@forksafe/contracts";
import {
  MoreInvestigationRequest,
  MoreInvestigationResponse,
  PanelData,
  PanelRequest,
  RecordReviewResponse,
  ReviewContextRequest,
  StartInvestigationRequest,
  StartInvestigationResponse,
  ReviewRequest,
  validateReview,
  type PanelData as PanelDataType,
  type MoreInvestigationRequest as MoreInvestigationRequestType,
  type MoreInvestigationResponse as MoreInvestigationResponseType,
  type StartInvestigationResponse as StartResponse,
} from "@forksafe/integrations-atlassian";
import { z } from "zod";
import {
  BackendHttpError,
  FeatureUnavailableError,
  type ForkSafeBackend,
} from "./backend.js";

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

const ReviewSubmitPayload = ReviewRequest.extend({
  notes: z.string().trim().min(1).max(4000),
  submitKey: z.string().uuid(),
}).strict();

const MoreInvestigationPayload = z.object({
  investigationId: z.string().uuid(),
  note: z.string().trim().min(1).max(500),
  extraEnvironments: z.coerce.number().int().min(1).max(3).optional(),
  submitKey: z.string().uuid(),
}).strict();

export function createHandlers(
  backend: ForkSafeBackend,
  {
    now = Date.now,
    fetchIssueLabels,
  }: { now?: () => number; fetchIssueLabels?: (issueKey: string) => Promise<string[]> } = {},
): {
  getPanel(req: HandlerRequest): Promise<HandlerResult<PanelDataType>>;
  getReviewDetails(req: HandlerRequest): Promise<HandlerResult<{
    candidateId: string;
    controllerSha256: string;
    changedFunctions: string[];
    rationale?: string;
    evaluation: {
      id: string;
      suite: "public" | "withheld";
      status: string;
      allRequiredPassed: boolean;
      passedCases: number;
      failedCases: number;
      totalCases: number;
      failedCaseIds?: string[];
    };
    evidencePackUrl?: string;
  }>>;
  startInvestigation(
    req: HandlerRequest,
  ): Promise<HandlerResult<StartResponse>>;
  submitReview(
    req: HandlerRequest,
  ): Promise<
    HandlerResult<{ reviewId: string; recorded: boolean }>
  >;
  requestMoreInvestigation(
    req: HandlerRequest,
  ): Promise<HandlerResult<MoreInvestigationResponseType>>;
  issueCreated(
    event: unknown,
  ): Promise<
    | { ok: true; mode: string; data: StartResponse }
    | { ok: false; code: string; message: string }
    | { ok: false; skipped: string }
  >;
} {
  return {
    async getPanel({ context }) {
      const issue = issueContext(context);
      if (!issue) return noIssueContext();
      try {
        const parsed = PanelData.parse(
          await backend.getPanel(PanelRequest.parse(issue)),
        );
        const data = PanelData.parse({
          ...parsed,
          candidates: parsed.candidates.map((candidate) => ({
            ...candidate,
            suites: candidate.suites?.map((suite) => {
              if (suite.suite !== "withheld") return suite;
              const { failedCaseIds: _withheldCaseIds, ...redacted } = suite;
              return redacted;
            }),
          })),
        });
        return { ok: true, mode: data.mode, data };
      } catch (error) {
        return mapHandlerError(error);
      }
    },

    async getReviewDetails({ payload, context }) {
      if (!issueContext(context)) return noIssueContext();
      let request: z.infer<typeof ReviewContextRequest>;
      try {
        request = ReviewContextRequest.strict().parse(payload);
      } catch (error) {
        return mapHandlerError(error);
      }
      try {
        const reviewContext = await backend.getReviewContext(request);
        const evaluation = reviewContext.evaluation;
        const passedCases = evaluation.cases.filter(
          (item) => item.status === "passed",
        );
        const failedCases = evaluation.cases.filter(
          (item) => item.status === "failed",
        );
        return {
          ok: true,
          mode: backend.mode,
          data: {
            candidateId: reviewContext.candidate.id,
            controllerSha256: reviewContext.candidate.controllerSha256,
            changedFunctions: reviewContext.candidate.changedFunctions,
            ...(reviewContext.candidate.rationale === undefined
              ? {}
              : { rationale: reviewContext.candidate.rationale }),
            evaluation: {
              id: evaluation.id,
              suite: evaluation.suite,
              status: evaluation.status,
              allRequiredPassed: evaluation.allRequiredPassed,
              passedCases: passedCases.length,
              failedCases: failedCases.length,
              totalCases: evaluation.cases.length,
              ...(evaluation.suite === "public"
                ? { failedCaseIds: failedCases.map((item) => item.caseId).slice(0, 50) }
                : {}),
            },
            ...(reviewContext.evidencePackUrl === undefined
              ? {}
              : { evidencePackUrl: reviewContext.evidencePackUrl }),
          },
        };
      } catch (error) {
        return mapHandlerError(error);
      }
    },

    async startInvestigation({ payload, context }) {
      const issue = issueContext(context);
      if (!issue) return noIssueContext();
      let form: z.infer<typeof StartPayload>;
      try {
        form = StartPayload.parse(payload ?? {});
      } catch (error) {
        return mapHandlerError(error);
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
        return mapHandlerError(error);
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
      let request: z.infer<typeof ReviewSubmitPayload>;
      try {
        request = ReviewSubmitPayload.parse(payload);
      } catch (error) {
        return mapHandlerError(error);
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
          reviewId: deterministicReviewId(context.accountId, request.submitKey),
          nowMs: now(),
          jiraIssueKey: issue.issueKey,
        });
        if (!validated.ok) {
          return mapDomainError(validated.code);
        }
        const recorded = RecordReviewResponse.parse(
          await backend.recordReview({ review: HumanReview.parse(validated.review) }),
        );
        return {
          ok: true,
          mode: backend.mode,
          data: { reviewId: recorded.reviewId, recorded: recorded.recorded },
        };
      } catch (error) {
        return mapHandlerError(error);
      }
    },

    async requestMoreInvestigation({ payload, context }) {
      if (!context.accountId) {
        return {
          ok: false,
          code: "unauthenticated",
          message: "Sign in to Jira before asking for more investigation.",
        };
      }
      const issue = issueContext(context);
      if (!issue) return noIssueContext();
      let form: z.infer<typeof MoreInvestigationPayload>;
      try {
        form = MoreInvestigationPayload.parse(payload);
      } catch (error) {
        return mapHandlerError(error);
      }
      try {
        const { submitKey, investigationId, ...formData } = form;
        const request = MoreInvestigationRequest.parse({
          investigationId,
          issueKey: issue.issueKey,
          projectKey: issue.projectKey,
          ...formData,
          requestedBy: `atlassian:${context.accountId}`,
          ...(form.extraEnvironments === undefined
            ? {}
            : { extraEnvironments: form.extraEnvironments }),
          idempotencyKey: submitKey,
        });
        const data = MoreInvestigationResponse.parse(
          await backend.requestMoreInvestigation(request),
        );
        return { ok: true, mode: backend.mode, data };
      } catch (error) {
        return mapHandlerError(error);
      }
    },

    async issueCreated(event) {
      const parsed = IssueCreatedEvent.safeParse(event);
      if (!parsed.success || !parsed.data.issue) {
        return { ok: false, skipped: "not_an_issue_event" };
      }
      const { issue } = parsed.data;
      let labelValues = (issue.fields.labels ?? []).map((label) =>
        typeof label === "string"
          ? label
          : label && typeof label === "object" && "name" in label
            ? String((label as { name?: unknown }).name ?? "")
            : "",
      );
      if (labelValues.length === 0 && fetchIssueLabels) {
        try {
          labelValues = await fetchIssueLabels(issue.key);
        } catch {
          return { ok: false, skipped: "label_lookup_failed" };
        }
      }
      const labels = labelValues.map((label) => label.trim().toLowerCase());
      if (!labels.includes("forksafe")) {
        return { ok: false, skipped: "missing_forsafe_label" };
      }
      try {
        const request = StartInvestigationRequest.parse({
          issueKey: issue.key,
          issueId: issue.id,
          projectKey: issue.fields.project.key,
          title: (issue.fields.summary ?? `${issue.key} investigation`).slice(0, 200),
          requestedEnvironments: 3,
        });
        const data = StartInvestigationResponse.parse(
          await backend.startInvestigation(request),
        );
        return { ok: true, mode: data.mode, data };
      } catch (error) {
        return mapHandlerError(error);
      }
    },
  };
}

const IssueCreatedEvent = z.object({
  issue: z
    .object({
      key: z.string().min(1),
      id: z.string().min(1),
      fields: z.object({
        project: z.object({ key: z.string().min(1) }),
        summary: z.string().min(1).optional(),
        labels: z.array(z.unknown()).optional(),
      }),
    })
    .optional(),
});

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

function deterministicReviewId(accountId: string, submitKey: string): ReviewId {
  const bytes = createHash("sha256")
    .update(`${accountId}:${submitKey}`)
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReviewId;
}

function mapHandlerError(error: unknown): HandlerResult<never> {
  if (error instanceof FeatureUnavailableError) {
    return {
      ok: false,
      code: "not_available_yet",
      message: "Asking for more investigation from Jira isn't available yet.",
    };
  }
  if (error instanceof BackendHttpError) {
    if (error.status === 401) {
      return {
        ok: false,
        code: "unauthorized",
        message: "Sign in to Jira again before continuing.",
      };
    }
    if (error.status === 403) {
      return {
        ok: false,
        code: "forbidden",
        message: "You don't have access to this ForkSafe investigation.",
      };
    }
    if (error.status === 404) {
      return {
        ok: false,
        code: "not_found",
        message: "This ForkSafe investigation could not be found.",
      };
    }
    if (error.status === 409) return mapDomainError(error.code);
  }
  return backendFailure();
}

function mapDomainError(code: string | undefined): HandlerResult<never> {
  if (
    code === "sha_mismatch" ||
    code === "candidate_mismatch" ||
    code === "evaluation_mismatch"
  ) {
    return {
      ok: false,
      code: "version_changed",
      message:
        "This candidate changed since you opened it. Reload the panel to review the latest version.",
    };
  }
  if (code === "review_conflict") {
    return {
      ok: false,
      code: "review_conflict",
      message:
        "This review conflicts with one already recorded. Reload the panel before trying again.",
    };
  }
  const validationMessages: Record<string, string> = {
    not_awaiting_review: "This investigation is no longer waiting for review.",
    candidate_not_evaluated: "This candidate has not finished evaluation yet.",
    evaluation_not_passed: "Only a candidate that passed all required checks can be approved.",
  };
  if (code && code in validationMessages) {
    return { ok: false, code, message: validationMessages[code]! };
  }
  if (code === "unauthenticated") {
    return {
      ok: false,
      code,
      message: "Sign in to Jira before submitting a review.",
    };
  }
  return backendFailure();
}

function backendFailure(): HandlerResult<never> {
  return {
    ok: false,
    code: "backend_error",
    message: "ForkSafe couldn't complete that request. Try again shortly.",
  };
}
