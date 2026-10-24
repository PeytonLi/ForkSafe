#!/usr/bin/env node
// Generates the recorded fixture investigation served by the fixture adapter.
// The trajectories are synthetic, kinematic-only stand-ins shaped like the
// simulator's SimRunResult so the UI can be developed before live data exists.
// They are labeled `fixture` everywhere in the UI and are never presented as
// MuJoCo-measured results.
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "fixtures", "demo.json");

const sha = (s) => createHash("sha256").update(s).digest("hex");
const uuid = (s) => {
  const h = sha(`uuid:${s}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const r = (n) => Math.round(n * 10000) / 10000;

const RECORDED_AT = Date.UTC(2026, 9, 24, 8, 0, 0);
const T0 = RECORDED_AT - 14 * 60 * 1000;
const ENGINE = "mujoco 3.17.0";
const ASSETS = "bcf7166c368900f13a2d4cd66f380b1502c2414960f6820b19d8774b0a15189a";

const SCENE = {
  divider_x: 0.5,
  divider_y: 0.0,
  divider_height: 0.15,
  divider_length: 0.3,
  cube_start_x: 0.5,
  cube_start_y: -0.2,
  target_x: 0.5,
  target_y: 0.2,
};

// --- kinematic stand-in trajectory -----------------------------------------
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (t) => t * t * (3 - 2 * t);
const SHOULDER = [0, 0, 0.333];
const L1 = 0.4;
const L2 = 0.47;
const CUBE_HALF = 0.025;

function armBodies(hand) {
  const wrist = [hand[0], hand[1], hand[2] + 0.107];
  const dx = wrist[0] - SHOULDER[0];
  const dy = wrist[1] - SHOULDER[1];
  const dz = wrist[2] - SHOULDER[2];
  const horiz = Math.hypot(dx, dy);
  const d = Math.min(Math.hypot(horiz, dz), L1 + L2 - 1e-6);
  const a = Math.acos((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d));
  const base = Math.atan2(dz, horiz);
  const yaw = Math.atan2(dy, dx);
  const ePlane = [L1 * Math.cos(base + a), L1 * Math.sin(base + a)];
  const elbow = [
    SHOULDER[0] + ePlane[0] * Math.cos(yaw),
    SHOULDER[1] + ePlane[0] * Math.sin(yaw),
    SHOULDER[2] + ePlane[1],
  ];
  return { yaw, shoulderPitch: base + a, elbowBend: a, elbow, wrist };
}

const IDQ = [1, 0, 0, 0];

function makeRun({ key, liftZ, speed, collide }) {
  const cubeStart = [SCENE.cube_start_x, SCENE.cube_start_y, CUBE_HALF];
  const target = [SCENE.target_x, SCENE.target_y, CUBE_HALF];
  const home = [0.3, 0, 0.5];
  const grip = 0.03; // hand sits this far above the cube centre when grasping
  const wp = [
    [home, 0.0, false],
    [[cubeStart[0], cubeStart[1], 0.2], 1.2, false],
    [[cubeStart[0], cubeStart[1], cubeStart[2] + grip], 0.8, false],
    [[cubeStart[0], cubeStart[1], cubeStart[2] + grip], 0.4, true],
    [[cubeStart[0], cubeStart[1], liftZ], 0.8, true],
    [[target[0], target[1], liftZ], 2.0, true],
    [[target[0], target[1], target[2] + grip], 0.9, true],
    [[target[0], target[1], target[2] + grip], 0.4, false],
    [[target[0], target[1], 0.3], 0.8, false],
  ];
  const segs = [];
  let t = 0;
  for (let i = 1; i < wp.length; i++) {
    const dur = wp[i][1] / speed;
    segs.push({ from: wp[i - 1][0], to: wp[i][0], t0: t, t1: t + dur, attached: wp[i][2] });
    t += dur;
  }
  const total = t + 0.6;
  const frames = [];
  const dt = 0.1; // 10 Hz viewer sample rate
  let cube = [...cubeStart];
  let prevQ = null;
  let firstFailure;
  let stalledHand = null;
  let completedAt;
  const stopAt = collide ? Math.min(total, 30) : total;
  for (let i = 0; Math.round(i * dt * 10) / 10 <= stopAt + 1e-9; i++) {
    const ts = Math.round(i * dt * 10) / 10;
    const seg = segs.find((s) => ts <= s.t1) ?? segs[segs.length - 1];
    const u = seg.t1 > seg.t0 ? Math.min(1, Math.max(0, (ts - seg.t0) / (seg.t1 - seg.t0))) : 1;
    let hand = stalledHand ?? lerp(seg.from, seg.to, smooth(u));
    let attached = stalledHand ? true : seg.attached && !(ts > segs[segs.length - 2].t1);
    if (attached) cube = [hand[0], hand[1], hand[2] - grip];
    const contacts = [];
    // forbidden contact: cube box overlaps divider box
    const divMinY = SCENE.divider_y - 0.01;
    const divMaxY = SCENE.divider_y + 0.01;
    const overlapY = Math.min(cube[1] + CUBE_HALF, divMaxY) - Math.max(cube[1] - CUBE_HALF, divMinY);
    const overlapZ = SCENE.divider_height - (cube[2] - CUBE_HALF);
    if (overlapY > 0 && overlapZ > 0) {
      const depth = Math.min(overlapY, overlapZ, 0.004);
      contacts.push({ a: "cube", b: "divider", depthM: r(depth) });
      contacts.push({ a: "hand", b: "divider", depthM: r(depth * 0.25) });
      if (!firstFailure && collide) {
        firstFailure = {
          kind: "forbidden_contact",
          tSec: ts,
          detail: `cube-divider penetration ${(depth * 1000).toFixed(1)} mm for >5 consecutive steps`,
        };
        stalledHand = hand;
      }
    }
    if (!collide && completedAt === undefined && ts > segs[segs.length - 2].t1 + 0.5) completedAt = ts;
    const k = armBodies(hand);
    const qpos = [k.yaw, -k.shoulderPitch + Math.PI / 2, 0, -k.elbowBend, 0, Math.PI / 2, Math.PI / 4, attached ? 0.02 : 0.04, attached ? 0.02 : 0.04].map(r);
    const qvel = prevQ ? qpos.map((q, j) => r((q - prevQ[j]) / dt)) : qpos.map(() => 0);
    prevQ = qpos;
    frames.push({
      tSec: ts,
      qpos,
      qvel,
      ctrl: qpos.slice(0, 7).concat([attached ? 0 : 255]),
      bodies: [
        { name: "link0", pos: [0, 0, 0], quat: IDQ },
        { name: "link1", pos: SHOULDER, quat: IDQ },
        { name: "link4", pos: k.elbow.map(r), quat: IDQ },
        { name: "link6", pos: k.wrist.map(r), quat: IDQ },
        { name: "hand", pos: hand.map(r), quat: [0, 1, 0, 0] },
        { name: "cube", pos: cube.map(r), quat: IDQ },
        { name: "divider", pos: [SCENE.divider_x, SCENE.divider_y, SCENE.divider_height / 2], quat: IDQ },
        { name: "target", pos: target.map(r), quat: IDQ },
      ],
      contacts,
      cubePos: cube.map(r),
      attached,
    });
    if (firstFailure && ts >= firstFailure.tSec + 4) break;
  }
  return {
    frames,
    completed: !collide,
    completionTimeSec: completedAt,
    failureKinds: collide ? ["forbidden_contact", "stalled"] : [],
    firstFailure,
    key,
  };
}

// --- investigation 1: awaiting review ---------------------------------------
const inv1 = uuid("inv-1");
const baseCtrlSha = sha("controller:baseline");
const baselineExp = uuid("exp-baseline");
const baselineCase = {
  caseId: "original-seed-1042",
  suite: "original",
  seed: 1042,
  sceneOverrides: SCENE,
  description: "Cube clips the divider during transit at the default 0.15 m lift height",
};
const art = (k) => uuid(`art-${k}`);
const replays = {};
const runs = {
  baseline: makeRun({ key: "baseline", liftZ: 0.15, speed: 1, collide: true }),
  candA: makeRun({ key: "candA", liftZ: 0.26, speed: 1, collide: false }),
  candB: makeRun({ key: "candB", liftZ: 0.22, speed: 0.7, collide: false }),
};
const candASha = sha("controller:candidate-a");
const candBSha = sha("controller:candidate-b");
const shaFor = { baseline: baseCtrlSha, candA: candASha, candB: candBSha };
for (const [k, run] of Object.entries(runs)) {
  replays[art(`replay-${k}`)] = {
    experimentId: k === "baseline" ? baselineExp : uuid(`exp-eval-${k}`),
    completed: run.completed,
    completionTimeSec: run.completionTimeSec,
    failureKinds: run.failureKinds,
    firstFailure: run.firstFailure,
    frames: run.frames,
    engineVersion: ENGINE,
    assetsSha256: ASSETS,
    controllerSha256: shaFor[k],
  };
}

const envs = [0, 1, 2].map((i) => ({
  id: uuid(`inv1-env-${i}`),
  investigationId: inv1,
  index: i,
  state: "closed",
  daytonaSandbox: { provider: "local", id: `fixture-sandbox-${i}` },
  budgets: { maxExperiments: 20, maxCandidates: 2, maxFactorySessions: 2, wallTimeMs: 600000 },
  startedAtMs: T0 + 60_000 + i * 4000,
  closedAtMs: T0 + 60_000 + 9 * 60_000 + i * 20_000,
}));
const sessions = envs.flatMap((e, i) =>
  [0, 1].slice(0, i === 2 ? 1 : 2).map((j) => ({
    id: uuid(`inv1-sess-${i}-${j}`),
    investigationId: inv1,
    environmentId: e.id,
    state: "closed",
    model: "fixture-model",
    mode: "fixture",
    tokenUsage: {
      inputTokens: 18000 + i * 4100 + j * 2300,
      outputTokens: 3100 + i * 700 + j * 250,
      cacheReadTokens: 9000,
      cacheCreationTokens: 1200,
      usageKnown: !(i === 2 && j === 0),
    },
    createdAtMs: e.startedAtMs + j * 5000,
    closedAtMs: e.closedAtMs,
  })),
);

const hyp = [
  ["Lift height too low", "raise transit clearance", "lift_height"],
  ["Transit too fast near divider", "slow approach", "transit_speed"],
  ["Grasp offset drifts", "re-center grasp", "grasp_offset"],
];
const experiments = [
  {
    id: baselineExp,
    investigationId: inv1,
    attemptId: uuid("att-baseline"),
    epoch: 0,
    simCase: baselineCase,
    status: "physics_failure",
    failureKinds: ["forbidden_contact", "stalled"],
    completed: false,
    changedFunctions: [],
    replayArtifactId: art("replay-baseline"),
    traceArtifactId: art("trace-baseline"),
    engineVersion: ENGINE,
    assetsSha256: ASSETS,
    controllerSha256: baseCtrlSha,
    startedAtMs: T0,
    finishedAtMs: T0 + 9000,
  },
];
const statuses = ["physics_failure", "succeeded", "constraint_violation", "succeeded", "physics_failure", "succeeded"];
envs.forEach((e, i) => {
  const n = [6, 5, 4][i];
  for (let j = 0; j < n; j++) {
    const st = statuses[(i + j) % statuses.length];
    experiments.push({
      id: uuid(`inv1-exp-${i}-${j}`),
      investigationId: inv1,
      environmentId: e.id,
      attemptId: uuid(`inv1-att-${i}-${j}`),
      epoch: 0,
      simCase: { ...baselineCase, caseId: `dev-${i}-${j}`, suite: "public", seed: 1042 + j, sceneOverrides: { ...SCENE, divider_y: r(0.01 * (j - 2)) } },
      status: st,
      failureKinds: st === "physics_failure" ? ["forbidden_contact"] : st === "constraint_violation" ? ["joint_limit"] : [],
      completed: st === "succeeded",
      completionTimeSec: st === "succeeded" ? r(6.1 + j * 0.3 + i * 0.5) : undefined,
      changedFunctions: j === 0 ? [] : [`plan_transit`, ...(i === 1 ? ["approach_speed"] : [])],
      engineVersion: ENGINE,
      assetsSha256: ASSETS,
      controllerSha256: sha(`controller:inv1-${i}-${j}`),
      startedAtMs: e.startedAtMs + 30_000 + j * 70_000,
      finishedAtMs: e.startedAtMs + 30_000 + j * 70_000 + 12_000,
    });
  }
});

const findings = [
  ["collision_frame", 0, "Cube bottom (z=0.120 m) is below the divider top (0.150 m) at transit start; first penetration at t=" + runs.baseline.firstFailure.tSec + " s.", "contact_event"],
  ["behavioral_note", 1, "Contact persists for more than 5 control steps, then plan_transit stalls instead of re-planning.", "trace_frame"],
  ["candidate_hypothesis", 0, "Raising transit_height to 0.26 m clears the divider with 6 cm margin across ±30 mm divider offsets.", "metric"],
  ["cross_environment_pattern", 2, "Env 1 and Env 2 both see the failure vanish when cube z > 0.175 m during transit; clearance, not speed, is the cause.", "metric"],
  ["limit_violation", 2, "Lifting above 0.30 m hits joint 4 lower limit for target_y > 0.22 m.", "log_excerpt"],
  ["candidate_hypothesis", 1, "Slowing the approach to 70% reduces penetration depth but times out on far-target cases.", "metric"],
  ["behavioral_note", 1, "Grasp offset is stable (±1.2 mm) across seeds 1042–1047; grasp drift is ruled out.", "trace_frame"],
].map(([kind, envIdx, summary, ek], i) => ({
  id: uuid(`inv1-find-${i}`),
  investigationId: inv1,
  environmentId: envs[envIdx].id,
  sessionId: sessions.find((s) => s.environmentId === envs[envIdx].id)?.id,
  kind,
  summary,
  evidence: [
    {
      kind: ek,
      experimentId: i === 0 ? baselineExp : uuid(`inv1-exp-${envIdx}-${i % 4}`),
      artifactId: i === 0 ? art("replay-baseline") : undefined,
      locator: i === 0 ? { tSec: runs.baseline.firstFailure.tSec, pair: ["cube", "divider"] } : { frameRange: [20 + i * 3, 30 + i * 3] },
      excerpt: i === 4 ? "WARN joint_limit joint4 q=-3.05 < -3.0718 (t=4.1s)" : undefined,
    },
  ],
  createdAtMs: T0 + 2 * 60_000 + i * 50_000,
}));

const candidates = [
  {
    id: uuid("inv1-cand-a"),
    investigationId: inv1,
    environmentId: envs[0].id,
    status: "evaluated",
    controllerSha256: candASha,
    sourceArtifactId: art("src-candA"),
    changedFunctions: ["plan_transit"],
    rationale: "Raise transit height from 0.15 m to 0.26 m so the carried cube clears the divider with margin.",
    basedOnFindings: [findings[0].id, findings[2].id, findings[3].id],
    submittedByAttemptId: uuid("inv1-att-cand-a"),
    submittedAtMs: T0 + 7 * 60_000,
  },
  {
    id: uuid("inv1-cand-b"),
    investigationId: inv1,
    environmentId: envs[1].id,
    status: "evaluated",
    controllerSha256: candBSha,
    sourceArtifactId: art("src-candB"),
    changedFunctions: ["plan_transit", "approach_speed"],
    rationale: "Raise transit height to 0.22 m and slow the approach to 70% speed.",
    basedOnFindings: [findings[5].id],
    submittedByAttemptId: uuid("inv1-att-cand-b"),
    submittedAtMs: T0 + 8 * 60_000,
  },
];

const publicCases = Array.from({ length: 10 }, (_, i) => (i === 0 ? "original-seed-1042" : `public-${String(i).padStart(2, "0")}`));
const withheldCases = Array.from({ length: 8 }, (_, i) => `withheld-${String(i + 1).padStart(2, "0")}`);
const evalFor = (c, key, suite, cases, failIdx) => {
  const rows = cases.map((caseId, i) => {
    const failed = failIdx.includes(i);
    return {
      caseId,
      status: failed ? "failed" : "passed",
      experimentId: uuid(`inv1-evalexp-${key}-${suite}-${i}`),
      completionTimeSec: failed ? undefined : r((key === "candA" ? 6.3 : 9.6) + (i % 4) * 0.21),
      failureKinds: failed ? ["timeout"] : [],
    };
  });
  const times = rows.filter((x) => x.completionTimeSec !== undefined).map((x) => x.completionTimeSec).sort((a, b) => a - b);
  return {
    id: uuid(`inv1-eval-${key}-${suite}`),
    candidateId: c.id,
    investigationId: inv1,
    evaluatorAttemptId: uuid(`inv1-evalatt-${key}-${suite}`),
    suite,
    cases: rows,
    allRequiredPassed: failIdx.length === 0,
    medianCompletionTimeSec: times.length ? times[Math.floor(times.length / 2)] : undefined,
    status: failIdx.length === 0 ? "passed" : "failed",
    reportArtifactId: art(`report-${key}-${suite}`),
    createdAtMs: c.submittedAtMs + 90_000 + (suite === "withheld" ? 60_000 : 0),
  };
};
const evaluations = [
  evalFor(candidates[0], "candA", "public", publicCases, []),
  evalFor(candidates[0], "candA", "withheld", withheldCases, []),
  evalFor(candidates[1], "candB", "public", publicCases, [6, 8]),
];

const diffs = {
  [candidates[0].id]: `--- a/controllers/task_controller.py
+++ b/controllers/task_controller.py
@@ -41,9 +41,9 @@ def plan_transit(state, target):
-    TRANSIT_HEIGHT_M = 0.15
+    TRANSIT_HEIGHT_M = 0.26  # clear divider (0.15 m) + cube half-height + margin
     lift = skills.move_to(state.hand_xy, z=TRANSIT_HEIGHT_M)
     carry = skills.move_to(target.xy, z=TRANSIT_HEIGHT_M)
     return [lift, carry, skills.descend(target)]
`,
  [candidates[1].id]: `--- a/controllers/task_controller.py
+++ b/controllers/task_controller.py
@@ -41,9 +41,9 @@ def plan_transit(state, target):
-    TRANSIT_HEIGHT_M = 0.15
+    TRANSIT_HEIGHT_M = 0.22
     lift = skills.move_to(state.hand_xy, z=TRANSIT_HEIGHT_M)
     carry = skills.move_to(target.xy, z=TRANSIT_HEIGHT_M)
     return [lift, carry, skills.descend(target)]
@@ -77,7 +77,7 @@ def approach_speed(distance_m):
-    return 1.0
+    return 0.7
`,
};

const replayByCandidate = {
  [candidates[0].id]: art("replay-candA"),
  [candidates[1].id]: art("replay-candB"),
};

const investigations = [
  {
    id: inv1,
    state: "awaiting_review",
    title: "Panda clips divider while carrying cube (seed 1042)",
    baselineCase,
    baselineExperimentId: baselineExp,
    jiraIssueKey: "FS-12",
    requestedEnvironments: 3,
    createdAtMs: T0,
    updatedAtMs: T0 + 11 * 60_000,
  },
];

// --- investigation 2: still searching (exercise cancellation) -------------
const inv2 = uuid("inv-2");
const inv2Base = uuid("inv2-exp-baseline");
investigations.push({
  id: inv2,
  state: "searching",
  title: "Cube placed outside target after fast transit (seed 77)",
  baselineCase: { caseId: "original-seed-77", suite: "original", seed: 77, sceneOverrides: { ...SCENE, target_y: 0.24 }, description: "Cube lands 41 mm short of the target region" },
  baselineExperimentId: inv2Base,
  requestedEnvironments: 3,
  createdAtMs: RECORDED_AT - 4 * 60_000,
  updatedAtMs: RECORDED_AT - 20_000,
});
const envs2 = [0, 1, 2].map((i) => ({
  id: uuid(`inv2-env-${i}`),
  investigationId: inv2,
  index: i,
  state: i === 2 ? "provisioning" : "active",
  daytonaSandbox: i === 2 ? undefined : { provider: "local", id: `fixture-sandbox-2${i}` },
  budgets: { maxExperiments: 20, maxCandidates: 2, maxFactorySessions: 2, wallTimeMs: 600000 },
  startedAtMs: i === 2 ? undefined : RECORDED_AT - 3 * 60_000 + i * 5000,
}));
const sessions2 = envs2.slice(0, 2).map((e, i) => ({
  id: uuid(`inv2-sess-${i}`),
  investigationId: inv2,
  environmentId: e.id,
  state: "streaming",
  model: "fixture-model",
  mode: "fixture",
  tokenUsage: { inputTokens: 6200 + i * 900, outputTokens: 800 + i * 120, cacheReadTokens: 0, cacheCreationTokens: 0, usageKnown: true },
  createdAtMs: e.startedAtMs,
}));
const experiments2 = [
  {
    id: inv2Base,
    investigationId: inv2,
    attemptId: uuid("inv2-att-base"),
    epoch: 0,
    simCase: investigations[1].baselineCase,
    status: "physics_failure",
    failureKinds: ["stalled"],
    completed: false,
    changedFunctions: [],
    engineVersion: ENGINE,
    assetsSha256: ASSETS,
    controllerSha256: baseCtrlSha,
    startedAtMs: RECORDED_AT - 5 * 60_000,
    finishedAtMs: RECORDED_AT - 5 * 60_000 + 8000,
  },
  ...envs2.slice(0, 2).map((e, i) => ({
    id: uuid(`inv2-exp-${i}`),
    investigationId: inv2,
    environmentId: e.id,
    attemptId: uuid(`inv2-att-${i}`),
    epoch: 1,
    simCase: { ...investigations[1].baselineCase, caseId: `dev-${i}-0`, suite: "public" },
    status: "running",
    failureKinds: [],
    completed: false,
    changedFunctions: ["release_cube"],
    engineVersion: ENGINE,
    assetsSha256: ASSETS,
    controllerSha256: sha(`controller:inv2-${i}`),
    startedAtMs: RECORDED_AT - 40_000 + i * 9000,
  })),
];
const findings2 = [
  {
    id: uuid("inv2-find-0"),
    investigationId: inv2,
    environmentId: envs2[0].id,
    sessionId: sessions2[0].id,
    kind: "behavioral_note",
    summary: "Gripper opens 0.12 s before the cube settles; release timing looks early at high transit speed.",
    evidence: [{ kind: "trace_frame", experimentId: inv2Base, locator: { frameRange: [61, 64] } }],
    createdAtMs: RECORDED_AT - 60_000,
  },
];

// --- investigation 3: permission denied -----------------------------------
const inv3 = uuid("inv-3");

const data = {
  recordedAtMs: RECORDED_AT,
  generator: "apps/web/scripts/gen-fixtures.mjs",
  investigations,
  restrictedInvestigations: [{ id: inv3, title: "Restricted: other project's investigation" }],
  environments: [...envs, ...envs2],
  sessions: [...sessions, ...sessions2],
  experiments: [...experiments, ...experiments2],
  findings: [...findings, ...findings2],
  candidates,
  evaluations,
  reviews: [],
  diffs,
  replays,
  replayByCandidate,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data) + "\n");
console.log(`wrote ${out} (${Object.values(replays).map((x) => x.frames.length).join("/")} frames)`);
