import { z } from "zod";
import {
  CandidateEvaluation,
  FailureKind,
  ControllerCandidate,
  ExperimentResult,
  Finding,
  HumanReview,
  Investigation,
} from "@forksafe/contracts";
import { canonicalJson, sha256Hex } from "../canonical.js";
import type { BundleCitation, EvidenceBundleInput, ReplayFrame } from "../bundle.js";

/** Shape of apps/web/src/fixtures/demo.json (read-only input). */
const DemoReplay = z.object({
  experimentId: z.string(),
  completed: z.boolean(),
  completionTimeSec: z.number().optional(),
  failureKinds: z.array(FailureKind).default([]),
  firstFailure: z.object({ kind: FailureKind, tSec: z.number(), detail: z.string().optional() }).optional(),
  frames: z.array(
    z.object({
      tSec: z.number(),
      bodies: z.array(z.object({ name: z.string(), pos: z.array(z.number()) })),
      contacts: z.array(z.object({ a: z.string(), b: z.string(), depthM: z.number().optional() })).default([]),
      attached: z.boolean().optional(),
    }),
  ),
  engineVersion: z.string(),
  assetsSha256: z.string(),
  controllerSha256: z.string(),
});

const Demo = z.object({
  recordedAtMs: z.number().int(),
  generator: z.string(),
  investigations: z.array(Investigation),
  sessions: z.array(z.object({ investigationId: z.string(), mode: z.string(), model: z.string().optional() })).default([]),
  environments: z.array(z.object({ investigationId: z.string(), daytonaSandbox: z.object({ provider: z.string(), id: z.string() }).optional() })).default([]),
  experiments: z.array(ExperimentResult),
  findings: z.array(Finding),
  candidates: z.array(ControllerCandidate),
  evaluations: z.array(CandidateEvaluation),
  reviews: z.array(HumanReview).default([]),
  diffs: z.record(z.string()),
  replays: z.record(DemoReplay),
  replayByCandidate: z.record(z.string()),
});

const frameOf = (f: z.infer<typeof DemoReplay>["frames"][number]): ReplayFrame => ({
  tSec: f.tSec,
  bodies: f.bodies.map((b) => ({ name: b.name, pos: [b.pos[0] ?? 0, b.pos[1] ?? 0, b.pos[2] ?? 0] })),
  contacts: f.contacts.map((c) => (c.depthM === undefined ? { a: c.a, b: c.b } : { a: c.a, b: c.b, depthM: c.depthM })),
  ...(f.attached === undefined ? {} : { attached: f.attached }),
});

/** Builds an evidence bundle from the web app's recorded fixture. Every
 *  integration is labeled `fixture`; nothing here claims to be live. Hashes
 *  over diffs/frames are computed here because the fixture records none. */
export function bundleFromDemo(demoJson: unknown, investigationId?: string): EvidenceBundleInput {
  const demo = Demo.parse(demoJson);
  const inv = investigationId
    ? demo.investigations.find((i) => i.id === investigationId)
    : demo.investigations.find((i) => demo.candidates.some((c) => c.investigationId === i.id));
  if (!inv) throw new Error("demo fixture has no matching investigation with candidates");
  const baseline = demo.experiments.find((e) => e.id === inv.baselineExperimentId);
  if (!baseline) throw new Error("demo fixture is missing the baseline experiment");

  const candidates = demo.candidates.filter((c) => c.investigationId === inv.id);
  const evaluations = demo.evaluations.filter((e) => e.investigationId === inv.id);
  const findings = demo.findings.filter((f) => f.investigationId === inv.id);
  const caseExperimentIds = new Set(evaluations.flatMap((e) => e.cases.map((c) => c.experimentId)));

  const replayEntries: { artifactId: string; candidateId?: string }[] = [];
  const baseReplayId = baseline.replayArtifactId;
  if (baseReplayId && demo.replays[baseReplayId]) replayEntries.push({ artifactId: baseReplayId });
  for (const c of candidates) {
    const id = demo.replayByCandidate[c.id];
    if (id && demo.replays[id]) replayEntries.push({ artifactId: id, candidateId: c.id });
  }

  const replays = replayEntries.map(({ artifactId, candidateId }) => {
    const r = demo.replays[artifactId] as z.infer<typeof DemoReplay>;
    const frames = r.frames.map(frameOf);
    return {
      artifactId,
      role: candidateId ? ("candidate" as const) : ("baseline" as const),
      ...(candidateId ? { candidateId } : {}),
      experimentId: r.experimentId,
      // The fixture generator replays every run on the baseline scene.
      caseId: inv.baselineCase.caseId,
      controllerSha256: r.controllerSha256,
      assetsSha256: r.assetsSha256,
      engineVersion: r.engineVersion,
      completed: r.completed,
      ...(r.completionTimeSec === undefined ? {} : { completionTimeSec: r.completionTimeSec }),
      failureKinds: r.failureKinds,
      ...(r.firstFailure ? { firstFailure: r.firstFailure } : {}),
      frames,
      framesSha256: sha256Hex(canonicalJson(frames)),
    };
  });

  const findingById = new Map(findings.map((f) => [f.id, f]));
  const citations: BundleCitation[] = [];
  for (const c of candidates) {
    for (const fid of c.basedOnFindings) {
      const f = findingById.get(fid);
      if (f) citations.push({ id: `${c.id}:${fid}`, source: "spacetimedb", title: `Candidate ${c.id.slice(0, 8)} cites: ${f.summary}`, ref: `finding/${fid}` });
    }
  }
  for (const e of evaluations) {
    if (e.reportArtifactId) citations.push({ id: `report:${e.id}`, source: "evaluator", title: `Evaluator ${e.suite} report for candidate ${e.candidateId.slice(0, 8)}`, ref: `artifact/${e.reportArtifactId}` });
  }

  const at = demo.recordedAtMs;
  const sandboxes = demo.environments.filter((e) => e.investigationId === inv.id && e.daytonaSandbox);
  const sessions = demo.sessions.filter((s) => s.investigationId === inv.id);
  return {
    bundleVersion: 1,
    generatedAtMs: at,
    source: {
      mode: "fixture",
      producer: "@forksafe/evidence-pack demo fixture",
      note: `Built from apps/web/src/fixtures/demo.json (${demo.generator}). Trajectories are synthetic kinematic stand-ins, not MuJoCo-measured results.`,
    },
    integrations: [
      { name: "simulator", mode: "fixture", detail: "synthetic kinematic trajectories", checkedAtMs: at },
      { name: "evaluator", mode: "fixture", detail: "recorded per-case results", checkedAtMs: at },
      { name: "factory", mode: "fixture", detail: `${sessions.length} recorded sessions${sessions[0]?.model ? ` (${sessions[0].model})` : ""}`, checkedAtMs: at },
      { name: "daytona", mode: "fixture", detail: `${sandboxes.length} placeholder sandboxes`, checkedAtMs: at },
      { name: "spacetimedb", mode: "fixture", detail: "findings and candidates from the fixture", checkedAtMs: at },
    ],
    investigation: inv,
    baseline: { experiment: baseline },
    hashes: {
      baselineControllerSha256: baseline.controllerSha256,
      assetsSha256: baseline.assetsSha256,
      engineVersion: baseline.engineVersion,
      sceneSha256: sha256Hex(canonicalJson(inv.baselineCase)),
    },
    candidates: candidates.map((c) => {
      const text = demo.diffs[c.id];
      if (text === undefined) throw new Error(`demo fixture has no diff for candidate ${c.id}`);
      return { candidate: c, diff: { text, sha256: sha256Hex(text), path: "controllers/task_controller.py" } };
    }),
    evaluations,
    experiments: demo.experiments.filter((e) => caseExperimentIds.has(e.id)),
    findings,
    citations,
    replays,
    reviews: demo.reviews.filter((r) => r.investigationId === inv.id),
  };
}
