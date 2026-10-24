import { z } from "zod";
import {
  ArtifactId,
  ArtifactRef,
  CandidateEvaluation,
  CandidateId,
  ControllerCandidate,
  ExperimentId,
  ExperimentResult,
  FailureKind,
  Finding,
  HumanReview,
  IntegrationMode,
  IntegrationReadiness,
  Investigation,
} from "@forksafe/contracts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase hex sha256");
const Vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

/** One sampled replay frame. Mirrors the simulator's SimRunResult frame
 *  shape; only positions are needed for the 2D projection. */
export const ReplayFrame = z.object({
  tSec: z.number().finite().nonnegative(),
  bodies: z
    .array(z.object({ name: z.string().min(1).max(64), pos: Vec3 }).passthrough())
    .max(64),
  contacts: z
    .array(z.object({ a: z.string(), b: z.string(), depthM: z.number().finite().optional() }).passthrough())
    .default([]),
  attached: z.boolean().optional(),
}).passthrough();
export type ReplayFrame = z.infer<typeof ReplayFrame>;

export const ReplayChunkRef = z.object({
  artifactId: ArtifactId,
  sha256: Sha256,
  bytes: z.number().int().nonnegative(),
  frameRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
});

export const BundleReplay = z
  .object({
    artifactId: ArtifactId,
    role: z.enum(["baseline", "candidate"]),
    candidateId: CandidateId.optional(),
    experimentId: ExperimentId,
    caseId: z.string().min(1),
    controllerSha256: Sha256,
    assetsSha256: Sha256,
    engineVersion: z.string().min(1),
    completed: z.boolean(),
    completionTimeSec: z.number().nonnegative().optional(),
    failureKinds: z.array(FailureKind).default([]),
    firstFailure: z
      .object({ kind: FailureKind, tSec: z.number().nonnegative(), detail: z.string().max(1000).optional() })
      .optional(),
    /** Inline sampled frames; framesSha256 = sha256(canonicalJson(frames)). */
    frames: z.array(ReplayFrame).max(20_000).optional(),
    framesSha256: Sha256.optional(),
    /** Large replays stay in artifact storage and are referenced by chunk. */
    chunks: z.array(ReplayChunkRef).max(1000).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.role === "candidate" && !r.candidateId) {
      ctx.addIssue({ code: "custom", path: ["candidateId"], message: "candidate replay needs candidateId" });
    }
    if (r.role === "baseline" && r.candidateId) {
      ctx.addIssue({ code: "custom", path: ["candidateId"], message: "baseline replay must not name a candidate" });
    }
    if (!r.frames && !r.chunks?.length) {
      ctx.addIssue({ code: "custom", path: ["frames"], message: "replay needs inline frames or chunk refs" });
    }
    if (r.frames && !r.framesSha256) {
      ctx.addIssue({ code: "custom", path: ["framesSha256"], message: "inline frames need framesSha256" });
    }
  });
export type BundleReplay = z.infer<typeof BundleReplay>;

export const BundleCandidate = z.object({
  candidate: ControllerCandidate,
  /** Exact unified diff against the baseline controller. */
  diff: z.object({
    text: z.string().max(2_000_000),
    sha256: Sha256,
    path: z.string().max(500).optional(),
  }),
});
export type BundleCandidate = z.infer<typeof BundleCandidate>;

export const BundleCitation = z.object({
  id: z.string().min(1).max(200),
  source: z.enum(["spacetimedb", "elastic", "elastic_agent_builder", "jira", "confluence", "artifact", "evaluator"]),
  title: z.string().min(1).max(500),
  ref: z.string().min(1).max(1000),
  revision: z.string().max(200).optional(),
});
export type BundleCitation = z.infer<typeof BundleCitation>;

export const EvidenceBundle = z.object({
  bundleVersion: z.literal(1),
  /** Supplied by the producer so rendering stays deterministic. */
  generatedAtMs: z.number().int().nonnegative(),
  source: z.object({
    /** Overall honesty label for the whole pack. */
    mode: IntegrationMode,
    producer: z.string().min(1).max(200),
    note: z.string().max(2000).optional(),
  }),
  integrations: z.array(IntegrationReadiness).default([]),
  investigation: Investigation,
  baseline: z.object({ experiment: ExperimentResult }),
  hashes: z.object({
    baselineControllerSha256: Sha256,
    assetsSha256: Sha256,
    engineVersion: z.string().min(1),
    /** sha256(canonicalJson(investigation.baselineCase)) when recorded. */
    sceneSha256: Sha256.optional(),
    suiteManifests: z.object({ public: Sha256.optional(), withheld: Sha256.optional() }).optional(),
    evaluatorSha256: Sha256.optional(),
  }),
  candidates: z.array(BundleCandidate).max(50),
  evaluations: z.array(CandidateEvaluation).max(200),
  /** Experiments referenced by evaluation cases, when available. */
  experiments: z.array(ExperimentResult).max(5000).default([]),
  findings: z.array(Finding).max(2000).default([]),
  citations: z.array(BundleCitation).max(2000).default([]),
  replays: z.array(BundleReplay).max(20).default([]),
  artifacts: z.array(ArtifactRef).max(5000).default([]),
  reviews: z.array(HumanReview).max(200).default([]),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundle>;
export type EvidenceBundleInput = z.input<typeof EvidenceBundle>;
