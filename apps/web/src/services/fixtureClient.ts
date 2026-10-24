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
import { z } from "zod";
import raw from "../fixtures/demo.json";
import { ServiceError } from "./errors";
import { fetchReadiness } from "./readiness";
import { fixtureAnswer, scopedQuestion } from "./ask";
import type {
  CancellationState,
  CaptureDraft,
  CaptureOutcome,
  EvidenceAnswer,
  ForkSafeClient,
  HandoffEvent,
  InvestigationListItem,
  InvestigationWorkspace,
  LiveStreamSnapshot,
  PipelineHealth,
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
  /** Replays recorded physics frames as an explicitly labeled demo stream. */
  simulateStream?: boolean;
}

interface FixtureStreamSource {
  investigationId: string;
  experimentId: string;
  replayArtifactId: string;
  frames: SimFrame[];
  originalStatus: ExperimentResult["status"];
  originalReplayArtifactId?: string;
  originalFinishedAtMs?: number;
}

interface FixtureStreamRun extends LiveStreamSnapshot {
  investigationId: string;
  experimentId: string;
  frames: SimFrame[];
  listeners: Set<(snapshot: LiveStreamSnapshot) => void>;
  cursor: number;
  timer?: ReturnType<typeof setTimeout>;
  started: boolean;
  originalStatus: ExperimentResult["status"];
  originalReplayArtifactId?: string;
  originalFinishedAtMs?: number;
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
  private fixtureStreams = new Map<string, FixtureStreamSource>();
  private liveRuns = new Map<string, FixtureStreamRun>();
  private simulateStream: boolean;

  constructor(opts: FixtureOptions = {}) {
    this.data = FixtureFile.parse(raw);
    this.latency = opts.latencyMs ?? 150;
    this.cancelConfirmMs = opts.cancelConfirmMs ?? 1500;
    this.storage = opts.storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : opts.storage;
    this.simulateStream = opts.simulateStream ?? false;
    if (this.simulateStream) this.prepareFixtureStreams();
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

  private prepareFixtureStreams() {
    const investigation = this.data.investigations[0];
    if (!investigation) return;
    const baseline = this.data.experiments.find((e) => e.id === investigation.baselineExperimentId);
    const baselineReplayId = baseline?.replayArtifactId;
    const baselineReplay = baselineReplayId ? this.data.replays[baselineReplayId] : undefined;
    if (!baseline || !baselineReplayId || !baselineReplay) return;
    const experiments = new Map<string, ExperimentResult>();
    experiments.set(baseline.id, baseline);
    for (const environment of this.data.environments.filter((e) => e.investigationId === investigation.id)) {
      const current = this.data.experiments
        .filter((e) => e.environmentId === environment.id)
        .sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
      if (current) experiments.set(current.id, current);
    }
    for (const experiment of experiments.values()) {
      const replayArtifactId = experiment.replayArtifactId ?? baselineReplayId;
      const replay = this.data.replays[replayArtifactId] ?? baselineReplay;
      this.fixtureStreams.set(experiment.id, {
        investigationId: investigation.id,
        experimentId: experiment.id,
        replayArtifactId,
        frames: replay.frames,
        originalStatus: experiment.status,
        originalReplayArtifactId: experiment.replayArtifactId,
        originalFinishedAtMs: experiment.finishedAtMs,
      });
      experiment.status = "running";
      experiment.replayArtifactId = undefined;
      experiment.finishedAtMs = undefined;
    }
  }

  private notifyLive(run: FixtureStreamRun) {
    const snapshot: LiveStreamSnapshot = {
      mode: "fixture",
      status: run.status,
      ...(run.reason ? { reason: run.reason } : {}),
      ...(run.replayArtifactId ? { replayArtifactId: run.replayArtifactId } : {}),
      chunks: run.chunks,
    };
    run.listeners.forEach((listener) => listener(snapshot));
  }

  private startFixtureStream(source: FixtureStreamSource, listener: (snapshot: LiveStreamSnapshot) => void) {
    let run = this.liveRuns.get(source.experimentId);
    if (!run) {
      run = {
        mode: "fixture",
        status: "waiting",
        chunks: [],
        investigationId: source.investigationId,
        experimentId: source.experimentId,
        frames: source.frames,
        listeners: new Set(),
        cursor: 0,
        started: false,
        originalStatus: source.originalStatus,
        originalReplayArtifactId: source.originalReplayArtifactId,
        originalFinishedAtMs: source.originalFinishedAtMs,
      };
      this.liveRuns.set(source.experimentId, run);
    }
    run.listeners.add(listener);
    listener({
      mode: "fixture",
      status: run.status,
      chunks: run.chunks,
      ...(run.replayArtifactId ? { replayArtifactId: run.replayArtifactId } : {}),
    });
    if (run.started || run.status === "finished") return;
    run.started = true;
    run.timer = setTimeout(() => {
      run!.status = "streaming";
      this.notifyLive(run!);
      const appendNext = () => {
        const end = Math.min(run!.cursor + 5, run!.frames.length);
        const frames = run!.frames.slice(run!.cursor, end);
        if (frames.length) {
          const seq = run!.chunks.length ? run!.chunks[run!.chunks.length - 1]!.seq + 1 : 0;
          run!.chunks = [...run!.chunks, { seq, final: end === run!.frames.length, frames }].slice(-8);
          run!.cursor = end;
          this.notifyLive(run!);
        }
        if (run!.cursor >= run!.frames.length) {
          run!.status = "finished";
          run!.replayArtifactId = source.replayArtifactId;
          this.notifyLive(run!);
          run!.timer = setTimeout(() => {
            const experiment = this.data.experiments.find((e) => e.id === run!.experimentId);
            if (experiment) {
              experiment.status = run!.originalStatus;
              experiment.replayArtifactId = run!.originalReplayArtifactId;
              experiment.finishedAtMs = run!.originalFinishedAtMs;
            }
            this.emit(run!.investigationId);
          }, 100);
          return;
        }
        run!.timer = setTimeout(appendNext, 500);
      };
      appendNext();
    }, 1500);
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

  watchLive(experimentId: string, onUpdate: (snapshot: LiveStreamSnapshot) => void): () => void {
    if (!this.simulateStream) {
      onUpdate({ mode: "fixture", status: "unavailable", reason: "fixture_no_physics", chunks: [] });
      return () => {};
    }
    const source = this.fixtureStreams.get(experimentId);
    if (!source) {
      onUpdate({ mode: "fixture", status: "unavailable", reason: "fixture_no_physics", chunks: [] });
      return () => {};
    }
    this.startFixtureStream(source, onUpdate);
    return () => this.liveRuns.get(experimentId)?.listeners.delete(onUpdate);
  }

  getReadiness() {
    return fetchReadiness();
  }

  /** Counts derived from the recorded environments; the fixture has no outbox. */
  getPipelineHealth(): Promise<PipelineHealth> {
    return this.wait(() => {
      const open = this.data.environments.filter((e) => e.state === "active" || e.state === "provisioning" || e.state === "paused");
      const runnerEnvs = new Set(this.data.sessions.filter((s) => s.state === "streaming" || s.state === "idle" || s.state === "created").map((s) => s.environmentId));
      return {
        mode: "fixture" as const,
        checkedAtMs: this.data.recordedAtMs,
        activeSandboxes: open.filter((e) => e.daytonaSandbox).length,
        sandboxCap: 5,
        runners: runnerEnvs.size,
        outboxBacklog: 0,
        outboxDead: 0,
      };
    });
  }

  askEvidence(investigationId: string, question: string): Promise<EvidenceAnswer> {
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          this.requireInvestigation(investigationId);
          const own = <T extends { investigationId: string; id: string }>(xs: T[]) => xs.filter((x) => x.investigationId === investigationId).map((x) => x.id);
          const known = [...own(this.data.environments), ...own(this.data.findings), ...own(this.data.experiments), ...own(this.data.candidates), ...own(this.data.sessions)];
          const q = scopedQuestion(question, investigationId, known);
          resolve(fixtureAnswer(this.data.findings.filter((f) => f.investigationId === investigationId), q));
        } catch (e) {
          reject(e);
        }
      }, this.latency * 4),
    );
  }

  /** Handoff steps reconstructed from recorded experiment start/finish times. */
  listHandoffs(investigationId: string): Promise<HandoffEvent[]> {
    return this.wait(() => {
      this.requireInvestigation(investigationId);
      return this.data.experiments
        .filter((x) => x.investigationId === investigationId && x.environmentId)
        .flatMap((x) => {
          const base = { jobId: x.attemptId, jobKind: "run_experiment", environmentId: x.environmentId, stale: false };
          const started: HandoffEvent[] = [
            { ...base, stage: "admission_reserved", atMs: x.startedAtMs },
            { ...base, stage: "grant_installed", atMs: x.startedAtMs + 1000 },
            { ...base, stage: "work_started", atMs: x.startedAtMs + 2000 },
          ];
          if (!x.finishedAtMs) return started;
          return [
            ...started,
            { ...base, stage: "artifacts_persisted" as const, atMs: x.finishedAtMs },
            { ...base, stage: "evidence_committed" as const, atMs: x.finishedAtMs + 1000 },
            { ...base, stage: "completion_acknowledged" as const, atMs: x.finishedAtMs + 2000 },
          ];
        });
    });
  }
}
