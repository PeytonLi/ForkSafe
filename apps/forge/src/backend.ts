import { invokeRemote } from "@forge/api";
import type { HumanReview, IntegrationMode } from "@forksafe/contracts";
import panelFixture from "./fixtures/panel.json" with { type: "json" };
import reviewContextFixture from "./fixtures/review-context.json" with { type: "json" };
import {
  FORGE_BACKEND_PATHS,
  FORGE_FEATURE_PATHS,
  MoreInvestigationRequest,
  MoreInvestigationResponse,
  PanelData,
  PanelRequest,
  RecordReviewRequest,
  RecordReviewResponse,
  ReviewContext,
  ReviewContextRequest,
  StartInvestigationRequest,
  StartInvestigationResponse,
  type PanelData as PanelDataType,
  type MoreInvestigationRequest as MoreInvestigationRequestType,
  type MoreInvestigationResponse as MoreInvestigationResponseType,
  type PanelRequest as PanelRequestType,
  type RecordReviewRequest as RecordReviewRequestType,
  type RecordReviewResponse as RecordReviewResponseType,
  type ReviewContextRequest as ReviewContextRequestType,
  type StartInvestigationRequest as StartInvestigationRequestType,
  type StartInvestigationResponse as StartInvestigationResponseType,
} from "@forksafe/integrations-atlassian";
import { z } from "zod";

type ReviewContextValue = z.infer<typeof ReviewContext>;

export class BackendHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super("ForkSafe backend request failed.");
    this.name = "BackendHttpError";
  }
}

export class FeatureUnavailableError extends Error {
  constructor() {
    super("Asking for more investigation is unavailable.");
    this.name = "FeatureUnavailableError";
  }
}

export interface ForkSafeBackend {
  mode: IntegrationMode;
  getPanel(req: PanelRequestType): Promise<PanelDataType>;
  startInvestigation(
    req: StartInvestigationRequestType,
  ): Promise<StartInvestigationResponseType>;
  getReviewContext(req: ReviewContextRequestType): Promise<ReviewContextValue>;
  recordReview(
    req: RecordReviewRequestType,
  ): Promise<RecordReviewResponseType>;
  requestMoreInvestigation(
    req: MoreInvestigationRequestType,
  ): Promise<MoreInvestigationResponseType>;
}

export function remoteBackend(): ForkSafeBackend {
  return {
    mode: "live",
    async getPanel(req) {
      return invokeBackend(
        FORGE_BACKEND_PATHS.panel,
        PanelRequest.parse(req),
        PanelData,
      );
    },
    async startInvestigation(req) {
      return invokeBackend(
        FORGE_BACKEND_PATHS.start,
        StartInvestigationRequest.parse(req),
        StartInvestigationResponse,
      );
    },
    async getReviewContext(req) {
      return invokeBackend(
        FORGE_BACKEND_PATHS.reviewContext,
        ReviewContextRequest.parse(req),
        ReviewContext,
      );
    },
    async recordReview(req) {
      return invokeBackend(
        FORGE_BACKEND_PATHS.review,
        RecordReviewRequest.parse(req),
        RecordReviewResponse,
      );
    },
    async requestMoreInvestigation(req) {
      try {
        return await invokeBackend(
          FORGE_FEATURE_PATHS.requests,
          MoreInvestigationRequest.parse(req),
          MoreInvestigationResponse,
        );
      } catch (error) {
        if (
          error instanceof BackendHttpError &&
          error.status === 404 &&
          error.code === undefined
        ) {
          throw new FeatureUnavailableError();
        }
        throw error;
      }
    },
  };
}

export function fixtureBackend(): ForkSafeBackend & {
  recordedReviews: HumanReview[];
} {
  const panel = parseFixture(PanelData, panelFixture);
  const parsedReviewContext = parseFixture<ReviewContextValue>(
    ReviewContext,
    reviewContextFixture,
  );
  const reviewContext = {
    ...parsedReviewContext,
    investigation: {
      ...parsedReviewContext.investigation,
      baselineCase: {
        ...parsedReviewContext.investigation.baselineCase,
        sceneOverrides:
          parsedReviewContext.investigation.baselineCase.sceneOverrides ?? {},
      },
    },
  };
  const recordedReviews: HumanReview[] = [];
  return {
    mode: "fixture",
    recordedReviews,
    async getPanel(req) {
      const request = PanelRequest.parse(req);
      return PanelData.parse({
        ...panel,
        mode: "fixture",
        issue: { key: request.issueKey, id: request.issueId },
      });
    },
    async startInvestigation(req) {
      StartInvestigationRequest.parse(req);
      return StartInvestigationResponse.parse({
        investigationId: panel.investigation?.id,
        state: "capturing",
        mode: "fixture",
      });
    },
    async getReviewContext(req) {
      ReviewContextRequest.parse(req);
      return reviewContext;
    },
    async recordReview(req) {
      const parsed = RecordReviewRequest.parse(req);
      recordedReviews.push(parsed.review);
      return RecordReviewResponse.parse({
        reviewId: parsed.review.id,
        recorded: true,
      });
    },
    async requestMoreInvestigation(req) {
      const parsed = MoreInvestigationRequest.parse(req);
      return MoreInvestigationResponse.parse({
        requestId: parsed.idempotencyKey,
        accepted: true,
      });
    },
  };
}

export function backendFromEnv(
  env = runtimeEnvironment(),
): ForkSafeBackend {
  return env.FORKSAFE_BACKEND_MODE === "remote"
    ? remoteBackend()
    : fixtureBackend();
}

async function invokeBackend<T>(
  path: string,
  req: unknown,
  schema: z.ZodType<T, any, any>,
): Promise<T> {
  const response = await invokeRemote("forksafe-backend", {
    path,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body: unknown = await response.json();
      if (
        body !== null &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string" &&
        /^[a-z_]{1,64}$/.test(body.error)
      ) {
        code = body.error;
      }
    } catch {
      code = undefined;
    }
    throw new BackendHttpError(response.status, code);
  }
  return schema.parse(await response.json());
}

function parseFixture<T>(
  schema: z.ZodType<T, any, any>,
  value: Record<string, unknown>,
): T {
  const { _fixture: _fixtureNote, ...response } = value;
  return schema.parse(response);
}

function runtimeEnvironment(): Record<string, string | undefined> {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env ?? {};
}
