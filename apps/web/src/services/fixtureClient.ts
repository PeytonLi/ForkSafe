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
import { z } from "zod";
import raw from "../fixtures/demo.json";
import { ServiceError } from "./errors";
import { fetchReadiness } from "./readiness";
import type {
  CancellationState,
  CaptureDraft,
  CaptureOutcome,
  ForkSafeClient,
  InvestigationListItem,
  InvestigationWorkspace,
  ReviewInput,
} from "./types";

const FixtureFile = z.object({
  recordedAtMs: z.number().int(),
  investigations: z.array(Investigation),
  restrictedInvestigations: z.array(z.object({ id: z.string().uuid(), title: z.string() })),
  environments: z.array(InvestigationEnvironment),
  sessions: z.array(AgentSession),
  experiments: z.array(ExperimentResult),
  findings: z.array(Finding),
  candidates: z.array(ControllerCandidate),
  evaluations: z.array(CandidateEvaluation),
  reviews: z.array(HumanReview),
  diffs: z.record(z.string()),
  replays: z.record(SimRunResult),
  replayByCandidate: z.record(z.string().uuid()),
});
type FixtureFile = z.infer<typeof FixtureFile>;

export const FIXTURE_REVIEWER = "local-dev-reviewer (fixture identity)";
const REVIEWS_KEY = "forksafe.fixture.reviews.v1";

export interface FixtureOptions {
  /** Delay applied to every call so loading states are observable. */
  latencyMs?: number;
  /** Delay between cancellation requested and confirmed. */
  cancelConfirmMs?: number;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

/** Serves the recorded demo investigation from local JSON. Writes (reviews,
 *  cancellation) stay in this browser only and are labeled as fixture. */
export class FixtureClient implements ForkSafeClient {
  readonly source = {
    kind: "fixture" as const,
    mode: "fixture" as const,
    detail: "Recorded fixture data from apps/web/src/fixtures/demo.json; reviews are kept in this browser only.",
  };
  private data: FixtureFile;
  private listeners = new Map<string, Set<() => void>>();
  private cancellations = new Map<string, CancellationState>();
  private latency: number;
  private cancelConfirmMs: number;
  private storage: FixtureOptions["storage"];

  constructor(opts: FixtureOptions = {}) {
    this.data = FixtureFile.parse(raw);
    this.latency = opts.latencyMs ?? 150;
    this.cancelConfirmMs = opts.cancelConfirmMs ?? 1500;
    this.storage = opts.storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : opts.storage;
    const stored = this.storage?.getItem(REVIEWS_KEY);
    if (stored) {
      const parsed = z.array(HumanReview).safeParse(JSON.parse(stored));
      if (parsed.success) this.data.reviews = parsed.data;
    }
  }

  private wait<T>(fn: () => T): Promise<T> {
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(fn());
        } catch (e) {
          reject(e);
        }
      }, this.latency),
    );
  }

  private emit(id: string) {
    this.listeners.get(id)?.forEach((l) => l());
  }

  private requireInvestigation(id: string): Investigation {
    if (this.data.restrictedInvestigations.some((r) => r.id === id))
      throw new ServiceError("permission_denied", "You do not have access to this investigation's project.");
    const inv = this.data.investigations.find((i) => i.id === id);
    if (!inv) throw new ServiceError("not_found", "Investigation not found.");
    return inv;
  }

  listInvestigations(): Promise<InvestigationListItem[]> {
    return this.wait(() => [
      ...this.data.investigations.map((i) => ({
        id: i.id,
        title: i.title,
        state: i.state,
        requestedEnvironments: i.requestedEnvironments,
        updatedAtMs: i.updatedAtMs,
      })),
      ...this.data.restrictedInvestigations.map((r) => ({ id: r.id, title: r.title, state: "restricted" as const })),
    ]);
  }

  getWorkspace(investigationId: string): Promise<InvestigationWorkspace> {
    return this.wait(() => {
      const investigation = this.requireInvestigation(investigationId);
      const by = <T extends { investigationId: string }>(xs: T[]) => xs.filter((x) => x.investigationId === investigationId);
      return {
        investigation,
        environments: by(this.data.environments).sort((a, b) => a.index - b.index),
        sessions: by(this.data.sessions),
        experiments: by(this.data.experiments),
        candidates: by(this.data.candidates),
        evaluations: by(this.data.evaluations),
        reviews: by(this.data.reviews),
        cancellation: this.cancellations.get(investigationId) ?? "none",
        asOfMs: this.data.recordedAtMs,
      };
    });
  }

  listFindings(investigationId: string): Promise<Finding[]> {
    return this.wait(() => {
      this.requireInvestigation(investigationId);
      return this.data.findings
        .filter((f) => f.investigationId === investigationId)
        .sort((a, b) => b.createdAtMs - a.createdAtMs);
    });
  }

  getReplay(artifactId: string): Promise<SimRunResult> {
    return this.wait(() => {
      const r = this.data.replays[artifactId];
      if (!r) throw new ServiceError("not_found", "Replay artifact not found.");
      return r;
    });
  }

  async getReplayForCandidate(candidateId: string): Promise<SimRunResult> {
    const art = this.data.replayByCandidate[candidateId];
    if (!art) throw new ServiceError("not_found", "No evaluated replay exists for this candidate yet.");
    return this.getReplay(art);
  }

  getCandidateDiff(candidateId: string): Promise<string> {
    return this.wait(() => {
      const d = this.data.diffs[candidateId];
      if (d === undefined) throw new ServiceError("not_found", "Diff artifact not found.");
      return d;
    });
  }

  cancelInvestigation(investigationId: string): Promise<void> {
    return this.wait(() => {
      const inv = this.requireInvestigation(investigationId);
      if (!["capturing", "admitted", "searching", "evaluating"].includes(inv.state))
        throw new ServiceError("conflict", `Investigation is ${inv.state}; nothing to cancel.`);
      this.cancellations.set(investigationId, "requested");
      this.emit(investigationId);
      setTimeout(() => {
        inv.state = "cancelled";
        inv.updatedAtMs = this.data.recordedAtMs;
        this.data.environments
          .filter((e) => e.investigationId === investigationId)
          .forEach((e) => (e.state = "closed"));
        this.cancellations.set(investigationId, "confirmed");
        this.emit(investigationId);
      }, this.cancelConfirmMs);
    });
  }

  submitReview(input: ReviewInput): Promise<HumanReview> {
    return this.wait(() => {
      this.requireInvestigation(input.investigationId);
      const cand = this.data.candidates.find((c) => c.id === input.candidateId);
      if (!cand) throw new ServiceError("not_found", "Candidate not found.");
      if (cand.controllerSha256 !== input.controllerSha256)
        throw new ServiceError("conflict", "Reviewed hash does not match the candidate's evaluated controller.");
      const ev = this.data.evaluations.find((e) => e.id === input.evaluationId && e.candidateId === cand.id);
      if (!ev) throw new ServiceError("conflict", "No evaluation for this exact candidate.");
      const review = HumanReview.parse({
        id: crypto.randomUUID(),
        investigationId: input.investigationId,
        candidateId: cand.id,
        evaluationId: ev.id,
        controllerSha256: input.controllerSha256,
        decision: input.decision,
        reviewerIdentity: FIXTURE_REVIEWER,
        notes: input.notes || undefined,
        createdAtMs: Date.now(),
      });
      this.data.reviews.push(review);
      this.storage?.setItem(REVIEWS_KEY, JSON.stringify(this.data.reviews));
      this.emit(input.investigationId);
      return review;
    });
  }

  requestCapture(_draft: CaptureDraft): Promise<CaptureOutcome> {
    return this.wait(() => ({
      accepted: false as const,
      mode: "fixture" as const,
      reason:
        "Fixture mode cannot run physics. Connect the simulator and Convex (set VITE_CONVEX_URL) to record a new baseline.",
    }));
  }

  subscribe(investigationId: string, onChange: () => void): () => void {
    const set = this.listeners.get(investigationId) ?? new Set();
    set.add(onChange);
    this.listeners.set(investigationId, set);
    return () => set.delete(onChange);
  }

  getReadiness() {
    return fetchReadiness();
  }
}
