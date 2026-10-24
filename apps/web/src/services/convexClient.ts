import {
  AgentSession,
  CandidateEvaluation,
  ControllerCandidate,
  ExperimentResult,
  Finding,
  HumanReview,
  Investigation,
  InvestigationEnvironment,
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
  EvidenceAnswer,
  ForkSafeClient,
  HandoffEvent,
  InvestigationListItem,
  InvestigationWorkspace,
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
  recordReview: "reviews:record",
} as const;

/** Read-only web functions living under convex/web/ (stretch views). */
export const CONVEX_WEB_FUNCTIONS = {
  pipelineHealth: "web/health:pipeline",
  ask: "web/ask:ask",
  handoffs: "web/timeline:handoffs",
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

export const CONVEX_RESPONSE_SCHEMAS = {
  listInvestigations: z.array(ListItem),
  workspace: Workspace,
  findings: z.array(Finding),
  replay: SimRunResult,
  candidateReplay: SimRunResult,
  candidateDiff: z.string(),
  capture: Capture,
  recordReview: HumanReview,
};

export const CONVEX_WEB_SCHEMAS = {
  pipelineHealth: PipelineHealthSchema,
  ask: EvidenceAnswerSchema,
  handoffs: z.array(HandoffEventSchema),
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
  subscribe(investigationId: string, onChange: () => void): () => void {
    const watches = [
      this.client.watchQuery(q(CONVEX_FUNCTIONS.workspace), { investigationId }),
      this.client.watchQuery(q(CONVEX_FUNCTIONS.findings), { investigationId }),
    ];
    const offs = watches.map((w) => w.onUpdate(onChange));
    return () => offs.forEach((off) => off());
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
