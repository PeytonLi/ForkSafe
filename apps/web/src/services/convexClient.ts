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
import type {
  CaptureDraft,
  CaptureOutcome,
  ForkSafeClient,
  InvestigationListItem,
  InvestigationWorkspace,
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

const q = (name: string) => makeFunctionReference<"query">(name);

const ListItem = z.object({
  id: z.string().uuid(),
  title: z.string(),
  state: z.union([Investigation.shape.state, z.literal("restricted")]),
  requestedEnvironments: z.number().int().optional(),
  updatedAtMs: z.number().int().optional(),
});
const Workspace = z.object({
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
const Capture = z.union([
  z.object({ accepted: z.literal(true), investigationId: z.string().uuid() }),
  z.object({ accepted: z.literal(false), mode: z.enum(["live", "local", "fixture", "blocked", "not_implemented"]), reason: z.string() }),
]);

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ServiceError("invalid_data", `${what} did not match @forksafe/contracts`);
  return r.data;
}

function mapError(e: unknown): never {
  if (e instanceof ServiceError) throw e;
  const msg = (e as Error)?.message ?? String(e);
  if (/unauthori[sz]ed|forbidden|permission/i.test(msg)) throw new ServiceError("permission_denied", msg);
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
    return parse(z.array(ListItem), await this.query(CONVEX_FUNCTIONS.listInvestigations), "Investigation list");
  }
  async getWorkspace(investigationId: string): Promise<InvestigationWorkspace> {
    return parse(Workspace, await this.query(CONVEX_FUNCTIONS.workspace, { investigationId }), "Workspace");
  }
  async listFindings(investigationId: string): Promise<Finding[]> {
    return parse(z.array(Finding), await this.query(CONVEX_FUNCTIONS.findings, { investigationId }), "Findings");
  }
  async getReplay(artifactId: string): Promise<SimRunResult> {
    return parse(SimRunResult, await this.query(CONVEX_FUNCTIONS.replay, { artifactId }), "Replay");
  }
  async getReplayForCandidate(candidateId: string): Promise<SimRunResult> {
    return parse(SimRunResult, await this.query(CONVEX_FUNCTIONS.candidateReplay, { candidateId }), "Replay");
  }
  async getCandidateDiff(candidateId: string): Promise<string> {
    return parse(z.string(), await this.query(CONVEX_FUNCTIONS.candidateDiff, { candidateId }), "Diff");
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
      return parse(HumanReview, r, "Review");
    } catch (e) {
      mapError(e);
    }
  }
  async requestCapture(draft: CaptureDraft): Promise<CaptureOutcome> {
    try {
      const r = await this.client.mutation(makeFunctionReference<"mutation">(CONVEX_FUNCTIONS.capture), { ...draft });
      return parse(Capture, r, "Capture outcome");
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
}
