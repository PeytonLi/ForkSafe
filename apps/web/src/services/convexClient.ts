import {
  AgentSession,
  CandidateEvaluation,
  ControllerCandidate,
  ExperimentResult,
  Finding,
  HumanReview,
  Investigation,
  InvestigationEnvironment,
  SimFrame,
  SimRunResult,
} from "@forksafe/contracts";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import { ServiceError } from "./errors";
import { fetchReadiness } from "./readiness";
import { scopedQuestion } from "./ask";
import type {
  CaptureDraft,
  CaptureOutcome,
  FailureSearchOutcome,
  EvidenceAnswer,
  ForkSafeClient,
  HandoffEvent,
  InvestigationListItem,
  InvestigationWorkspace,
  CurrentController,
  LearningView,
  LiveStreamSnapshot,
  PipelineHealth,
  ReviewInput,
} from "./types";

/** Convex function names this client expects the convex lane to expose.
 *  Documented in apps/web/README.md; every response is validated against
 *  @forksafe/contracts before it reaches a component. */
export const CONVEX_FUNCTIONS = {
  listInvestigations: "investigations:list",
  workspace: "investigations:workspace",
  findings: "evidence:findings",
  replay: "artifacts:replay",
  candidateReplay: "candidates:replay",
  candidateDiff: "candidates:diff",
  cancel: "investigations:cancel",
  capture: "investigations:capture",
  findFailure: "sceneSearch:findFailure",
  recordReview: "reviews:record",
} as const;

/** Read-only web functions living under convex/web/ (stretch views). */
export const CONVEX_WEB_FUNCTIONS = {
  pipelineHealth: "web/health:pipeline",
  ask: "web/ask:ask",
  handoffs: "web/timeline:handoffs",
  live: "web/live:latest",
} as const;

export const CONVEX_LEARNING_FUNCTIONS = {
  learning: "learning:view",
  retry: "learning:retry",
  currentController: "learning:currentController",
} as const;

const q = (name: string) => makeFunctionReference<"query">(name);

export const ListItem = z.object({
  id: z.string().uuid(),
  title: z.string(),
  state: z.union([Investigation.shape.state, z.literal("restricted")]),
  requestedEnvironments: z.number().int().optional(),
  updatedAtMs: z.number().int().optional(),
});
export const Workspace = z.object({
  investigation: Investigation,
  environments: z.array(InvestigationEnvironment),
  sessions: z.array(AgentSession),
  experiments: z.array(ExperimentResult),
  candidates: z.array(ControllerCandidate),
  evaluations: z.array(CandidateEvaluation),
  reviews: z.array(HumanReview),
  cancellation: z.enum(["none", "requested", "confirmed"]).default("none"),
  asOfMs: z.number().int(),
});
export const Capture = z.union([
  z.object({ accepted: z.literal(true), investigationId: z.string().uuid() }),
  z.object({ accepted: z.literal(false), mode: z.enum(["live", "local", "fixture", "blocked", "not_implemented"]), reason: z.string() }),
]);
export const FailureSearch = z.union([
  z.object({
    mode: z.enum(["live", "local", "fixture", "blocked", "not_implemented"]),
    found: z.literal(false),
    samples: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  z.object({
    mode: z.enum(["live", "local", "fixture", "blocked", "not_implemented"]),
    found: z.literal(true),
    taskFamily: z.enum(["divider_pick_place", "push_through_gap", "bin_drop"]),
    caseId: z.string(),
    sceneOverrides: z.record(z.string(), z.number()),
    seed: z.number().int().nonnegative(),
    samples: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    failureKind: z.string().optional(),
  }),
]);

const LearningExperiment = z.object({
  experimentId: z.string(),
  status: z.string(),
  completed: z.boolean(),
  completionTimeSec: z.number().optional(),
  firstFailure: z.object({ kind: z.string(), tSec: z.number(), detail: z.string() }).optional(),
  replayArtifactId: z.string().optional(),
  controllerSha256: z.string(),
  failureKinds: z.array(z.string()).default([]),
});
export const LearningViewSchema = z.object({
  taskFamily: z.string().default("divider_pick_place"),
  lineage: z.array(z.object({
    version: z.number(),
    controllerSha256: z.string(),
    label: z.string(),
    investigationId: z.string().optional(),
    investigationTitle: z.string().optional(),
    candidateId: z.string().optional(),
    approvedAtMs: z.number().optional(),
  })).default([]),
  current: z.object({ version: z.number(), controllerSha256: z.string() }).nullable().default(null),
  thisRun: z.object({
    controllerSha256: z.string().nullable().default(null),
    version: z.number().nullable().default(null),
    choice: z.enum(["approved", "baseline"]).nullable().default(null),
  }).default({ controllerSha256: null, version: null, choice: null }),
  retry: z.object({
    available: z.boolean().default(false),
    reason: z.string().optional(),
    latest: z.object({
      investigationId: z.string(),
      state: z.string(),
      captureStatus: z.string().nullable(),
      controllerSha256: z.string().nullable(),
      controllerVersion: z.number().nullable(),
      before: LearningExperiment.nullable(),
      after: LearningExperiment.nullable(),
      recorded: z.boolean().optional(),
    }).optional(),
  }).default({ available: false }),
  priorHints: z.array(z.object({
    findingId: z.string(),
    sourceInvestigationId: z.string(),
    sourceTitle: z.string(),
    summary: z.string(),
    used: z.boolean().default(false),
  })).default([]),
});
export const CurrentControllerSchema = z.object({
  taskFamily: z.string().default("divider_pick_place"),
  approved: z.object({
    version: z.number(),
    controllerSha256: z.string(),
    investigationTitle: z.string().optional(),
  }).nullable().default(null),
  baseline: z.object({ version: z.literal(1), controllerSha256: z.string() }).nullable().default(null),
});
export const CONVEX_LEARNING_SCHEMAS = {
  learning: LearningViewSchema,
  retry: Capture,
  currentController: CurrentControllerSchema,
} as const;

const Mode = z.enum(["live", "local", "fixture", "blocked", "not_implemented"]);
export const PipelineHealthSchema = z.object({
  mode: Mode,
  checkedAtMs: z.number().int(),
  activeSandboxes: z.number().int().nonnegative(),
  sandboxCap: z.number().int().positive(),
  runners: z.number().int().nonnegative(),
  outboxBacklog: z.number().int().nonnegative(),
  outboxDead: z.number().int().nonnegative(),
  oldestBacklogAtMs: z.number().int().optional(),
});
export const EvidenceAnswerSchema = z.object({
  mode: Mode,
  enoughEvidence: z.boolean(),
  answer: z.string().max(8000).optional(),
  label: z.string().optional(),
  reason: z.string().optional(),
  citations: z.array(z.object({
    id: z.string().min(1),
    docType: z.enum(["finding", "evidence", "experiment_result"]),
    summary: z.string(),
    environmentId: z.string().optional(),
    tSec: z.number().nonnegative().optional(),
  })),
  withheld: z.array(z.object({ id: z.string().min(1), reason: z.string() })),
});
export const HandoffEventSchema = z.object({
  jobId: z.string(),
  jobKind: z.string(),
  environmentId: z.string().optional(),
  stage: z.enum(["admission_reserved", "grant_installed", "work_started", "artifacts_persisted", "evidence_committed", "completion_acknowledged"]),
  atMs: z.number(),
  stale: z.boolean(),
});
export const LiveStreamResponseSchema = z.object({
  status: z.enum(["waiting", "streaming", "finished", "unavailable"]),
  reason: z.string().optional(),
  replayArtifactId: z.string().uuid().optional(),
  nextSeq: z.number().int().nonnegative(),
  chunks: z.array(z.object({
    seq: z.number().int().nonnegative(),
    final: z.boolean(),
    frames: z.array(SimFrame),
  })),
}).nullable();

export const CONVEX_RESPONSE_SCHEMAS = {
  listInvestigations: z.array(ListItem),
  workspace: Workspace,
  findings: z.array(Finding),
  replay: SimRunResult,
  candidateReplay: SimRunResult,
  candidateDiff: z.string(),
  capture: Capture,
  findFailure: FailureSearch,
  recordReview: HumanReview,
};

export const CONVEX_WEB_SCHEMAS = {
  pipelineHealth: PipelineHealthSchema,
  ask: EvidenceAnswerSchema,
  handoffs: z.array(HandoffEventSchema),
  live: LiveStreamResponseSchema,
};

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ServiceError("invalid_data", `${what} did not match @forksafe/contracts`);
  return r.data;
}

function mapError(e: unknown): never {
  if (e instanceof ServiceError) throw e;
  const msg = (e as Error)?.message ?? String(e);
  if (/unauthori[sz]ed|forbidden|permission/i.test(msg)) throw new ServiceError("permission_denied", msg);
  if (/out_of_scope/i.test(msg)) throw new ServiceError("out_of_scope", "Questions can only be about this investigation.");
  if (/invalid_input/i.test(msg)) throw new ServiceError("invalid_input", "That question can't be sent. Try rephrasing it.");
  if (/not found/i.test(msg)) throw new ServiceError("not_found", msg);
  throw new ServiceError("unavailable", msg);
}

/** Lifecycle reads/writes via Convex; evidence (SpacetimeDB) reaches the
 *  browser through Convex queries backed by the trusted bridge projection. */
export class ConvexForkSafeClient implements ForkSafeClient {
  readonly source;
  private client: ConvexReactClient;

  constructor(url: string) {
    this.client = new ConvexReactClient(url);
    this.source = {
      kind: "convex" as const,
      mode: (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url) ? "local" : "live") as "local" | "live",
      detail: `Convex deployment ${new URL(url).host}`,
    };
  }

  get react(): ConvexReactClient {
    return this.client;
  }

  private async query(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await this.client.query(q(name), args);
    } catch (e) {
      mapError(e);
    }
  }

  async listInvestigations(): Promise<InvestigationListItem[]> {
    return parse(CONVEX_RESPONSE_SCHEMAS.listInvestigations, await this.query(CONVEX_FUNCTIONS.listInvestigations), "Investigation list");
  }
  async getWorkspace(investigationId: string): Promise<InvestigationWorkspace> {
    return parse(CONVEX_RESPONSE_SCHEMAS.workspace, await this.query(CONVEX_FUNCTIONS.workspace, { investigationId }), "Workspace");
  }
  async listFindings(investigationId: string): Promise<Finding[]> {
    return parse(CONVEX_RESPONSE_SCHEMAS.findings, await this.query(CONVEX_FUNCTIONS.findings, { investigationId }), "Findings");
  }
  async getReplay(artifactId: string): Promise<SimRunResult> {
    return parse(CONVEX_RESPONSE_SCHEMAS.replay, await this.query(CONVEX_FUNCTIONS.replay, { artifactId }), "Replay");
  }
  async getReplayForCandidate(candidateId: string): Promise<SimRunResult> {
    return parse(CONVEX_RESPONSE_SCHEMAS.candidateReplay, await this.query(CONVEX_FUNCTIONS.candidateReplay, { candidateId }), "Replay");
  }
  async getCandidateDiff(candidateId: string): Promise<string> {
    return parse(CONVEX_RESPONSE_SCHEMAS.candidateDiff, await this.query(CONVEX_FUNCTIONS.candidateDiff, { candidateId }), "Diff");
  }
  async cancelInvestigation(investigationId: string): Promise<void> {
    try {
      await this.client.mutation(makeFunctionReference<"mutation">(CONVEX_FUNCTIONS.cancel), { investigationId });
    } catch (e) {
      mapError(e);
    }
  }
  async submitReview(input: ReviewInput): Promise<HumanReview> {
    try {
      const r = await this.client.action(makeFunctionReference<"action">(CONVEX_FUNCTIONS.recordReview), { ...input });
      return parse(CONVEX_RESPONSE_SCHEMAS.recordReview, r, "Review");
    } catch (e) {
      mapError(e);
    }
  }
  async requestCapture(draft: CaptureDraft): Promise<CaptureOutcome> {
    try {
      const r = await this.client.mutation(makeFunctionReference<"mutation">(CONVEX_FUNCTIONS.capture), { ...draft });
      return parse(CONVEX_RESPONSE_SCHEMAS.capture, r, "Capture outcome");
    } catch (e) {
      mapError(e);
    }
  }
  async findFailure(
    taskFamily: import("@forksafe/contracts").TaskFamily,
    options?: { sceneOverrides?: Record<string, number>; seed?: number },
  ): Promise<FailureSearchOutcome> {
    try {
      const result = await this.client.action(makeFunctionReference<"action">(CONVEX_FUNCTIONS.findFailure), {
        taskFamily,
        ...(options?.sceneOverrides !== undefined ? { sceneOverrides: options.sceneOverrides } : {}),
        ...(options?.seed !== undefined ? { seed: options.seed } : {}),
      });
      return parse(CONVEX_RESPONSE_SCHEMAS.findFailure, result, "Failure search") as FailureSearchOutcome;
    } catch (e) {
      mapError(e);
    }
  }
  async getLearning(investigationId: string): Promise<LearningView> {
    return parse(LearningViewSchema, await this.query(CONVEX_LEARNING_FUNCTIONS.learning, { investigationId }), "Learning view");
  }
  async retryWithImprovedController(investigationId: string): Promise<CaptureOutcome> {
    try {
      const result = await this.client.mutation(makeFunctionReference<"mutation">(CONVEX_LEARNING_FUNCTIONS.retry), { investigationId });
      return parse(CONVEX_RESPONSE_SCHEMAS.capture, result, "Retry outcome");
    } catch (e) {
      mapError(e);
    }
  }
  async getCurrentController(taskFamily?: string): Promise<CurrentController> {
    const args = taskFamily ? { taskFamily } : {};
    return parse(CurrentControllerSchema, await this.query(CONVEX_LEARNING_FUNCTIONS.currentController, args), "Current controller");
  }
  subscribe(investigationId: string, onChange: () => void): () => void {
    const watches = [
      this.client.watchQuery(q(CONVEX_FUNCTIONS.workspace), { investigationId }),
      this.client.watchQuery(q(CONVEX_FUNCTIONS.findings), { investigationId }),
      this.client.watchQuery(q(CONVEX_LEARNING_FUNCTIONS.learning), { investigationId }),
    ];
    const offs = watches.map((w) => w.onUpdate(onChange));
    return () => offs.forEach((off) => off());
  }
  watchLive(experimentId: string, onUpdate: (snapshot: LiveStreamSnapshot) => void): () => void {
    const watch = this.client.watchQuery(q(CONVEX_WEB_FUNCTIONS.live), { experimentId });
    onUpdate({ mode: this.source.mode, status: "waiting", chunks: [] });
    return watch.onUpdate(() => {
      try {
        const result = parse(CONVEX_WEB_SCHEMAS.live, watch.localQueryResult(), "Live stream");
        onUpdate(result
          ? { mode: this.source.mode, ...result }
          : { mode: this.source.mode, status: "waiting", chunks: [] });
      } catch {
        onUpdate({ mode: this.source.mode, status: "unavailable", reason: "stream_error", chunks: [] });
      }
    });
  }
  getReadiness() {
    return fetchReadiness();
  }
  async getPipelineHealth(): Promise<PipelineHealth> {
    return parse(CONVEX_WEB_SCHEMAS.pipelineHealth, await this.query(CONVEX_WEB_FUNCTIONS.pipelineHealth), "Pipeline health");
  }
  async askEvidence(investigationId: string, question: string): Promise<EvidenceAnswer> {
    const q = scopedQuestion(question, investigationId);
    try {
      const r = await this.client.action(makeFunctionReference<"action">(CONVEX_WEB_FUNCTIONS.ask), { investigationId, question: q });
      return parse(CONVEX_WEB_SCHEMAS.ask, r, "Evidence answer");
    } catch (e) {
      mapError(e);
    }
  }
  async listHandoffs(investigationId: string): Promise<HandoffEvent[]> {
    return parse(CONVEX_WEB_SCHEMAS.handoffs, await this.query(CONVEX_WEB_FUNCTIONS.handoffs, { investigationId }), "Handoffs");
  }
}
