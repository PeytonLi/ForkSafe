import { invokeRemote } from "@forge/api";
import type { HumanReview, IntegrationMode } from "@forksafe/contracts";
import panelFixture from "./fixtures/panel.json" with { type: "json" };
import reviewContextFixture from "./fixtures/review-context.json" with { type: "json" };
import {
  FORGE_BACKEND_PATHS,
  PanelData,
  PanelRequest,
  RecordReviewRequest,
  RecordReviewResponse,
  ReviewContext,
  ReviewContextRequest,
  StartInvestigationRequest,
  StartInvestigationResponse,
  type PanelData as PanelDataType,
  type PanelRequest as PanelRequestType,
  type RecordReviewRequest as RecordReviewRequestType,
  type RecordReviewResponse as RecordReviewResponseType,
  type ReviewContextRequest as ReviewContextRequestType,
  type StartInvestigationRequest as StartInvestigationRequestType,
  type StartInvestigationResponse as StartInvestigationResponseType,
} from "@forksafe/integrations-atlassian";
import { z } from "zod";

type ReviewContextValue = z.infer<typeof ReviewContext>;

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
    throw new Error(`ForkSafe backend returned HTTP ${response.status}.`);
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
