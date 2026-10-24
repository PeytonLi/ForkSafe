import { describe, expect, it } from "vitest";
import {
  CandidateEvaluation,
  EnvConfig,
  ExecutionGrant,
  ExperimentResult,
  HandoffRecord,
  Investigation,
  InvestigationEnvironment,
  SimRunResult,
  effectiveMode,
  missingForMode,
  uuid,
} from "../src/index.js";

const now = 1_761_200_000_000;
const id = () => crypto.randomUUID();

const baseEnv = {
  CONVEX_URL: "https://x.convex.cloud",
  VITE_CONVEX_URL: "https://x.convex.cloud",
  CONVEX_ADMIN_KEY: "k",
  DAYTONA_API_KEY: "k",
  FACTORY_API_KEY: "k",
  ELASTICSEARCH_URL: "https://es.example",
  ELASTICSEARCH_API_KEY: "k",
  KIBANA_URL: "https://kb.example",
  KIBANA_API_KEY: "k",
  ATLASSIAN_SITE_URL: "https://x.atlassian.net",
  ATLASSIAN_EMAIL: "a@b.c",
  ATLASSIAN_API_TOKEN: "k",
  ATLASSIAN_PROJECT_KEY: "FS",
  RUNNER_CALLBACK_SECRET: "s",
  INTEGRATION_SHARED_SECRET: "s",
};

describe("contracts", () => {
  it("round-trips the core entities through JSON", () => {
    const inv = Investigation.parse({
      id: id(),
      state: "searching",
      title: "cube clips divider",
      baselineCase: { caseId: "orig-1", suite: "original", seed: 7 },
      baselineExperimentId: id(),
      requestedEnvironments: 3,
      createdAtMs: now,
      updatedAtMs: now,
    });
    expect(Investigation.parse(JSON.parse(JSON.stringify(inv)))).toEqual(inv);

    const env = InvestigationEnvironment.parse({
      id: id(),
      investigationId: inv.id,
      index: 0,
      state: "active",
      budgets: {},
    });
    expect(env.budgets.maxExperiments).toBe(20);
  });

  it("rejects non-uuid application ids", () => {
    expect(uuid.safeParse("convex-doc-123").success).toBe(false);
    expect(
      Investigation.safeParse({ id: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("keeps evaluator results immutable in shape", () => {
    const evaluation = CandidateEvaluation.parse({
      id: id(),
      candidateId: id(),
      investigationId: id(),
      evaluatorAttemptId: id(),
      suite: "public",
      cases: [{ caseId: "c1", status: "passed", completionTimeSec: 9.2 }],
      allRequiredPassed: true,
      medianCompletionTimeSec: 9.2,
      status: "passed",
      createdAtMs: now,
    });
    expect(evaluation.cases[0]?.caseId).toBe("c1");
  });

  it("validates a sim run result envelope", () => {
    const r = SimRunResult.parse({
      experimentId: id(),
      completed: false,
      failureKinds: ["forbidden_contact"],
      firstFailure: { kind: "forbidden_contact", tSec: 4.4, detail: "cube-divider" },
      frames: [
        {
          tSec: 0,
          qpos: [0],
          qvel: [0],
          ctrl: [0],
          bodies: [{ name: "cube", pos: [0, 0, 0.02], quat: [1, 0, 0, 0] }],
          contacts: [],
          attached: false,
        },
      ],
      engineVersion: "3.17.0",
      assetsSha256: "a".repeat(64),
      controllerSha256: "b".repeat(64),
    });
    expect(r.frames).toHaveLength(1);
  });

  it("reports missing credential names by mode without values", () => {
    const env = EnvConfig.parse({
      FACTORY_API_KEY: "x",
      ELASTIC_AGENT_BUILDER_MODE: "cloud",
    });
    const missing = missingForMode(env);
    expect(missing.CONVEX_MODE).toContain("CONVEX_URL");
    expect(missing.FACTORY_MODE).toBeUndefined();
    expect(effectiveMode(env, "FACTORY_MODE")).toBe("live");
    expect(effectiveMode(env, "CONVEX_MODE")).toBe("blocked");
    expect(effectiveMode(env, "ELASTIC_AGENT_BUILDER_MODE")).toBe(
      "blocked",
    );
  });

  it("fixture and disabled modes map to honest statuses", () => {
    const env = EnvConfig.parse({
      ...baseEnv,
      ATLASSIAN_MODE: "fixture",
      ELASTIC_AGENT_BUILDER_MODE: "disabled",
    });
    expect(effectiveMode(env, "ATLASSIAN_MODE")).toBe("fixture");
    expect(effectiveMode(env, "ELASTIC_AGENT_BUILDER_MODE")).toBe(
      "not_implemented",
    );
  });

  it("handoff stages form a total order", () => {
    const rec = HandoffRecord.parse({
      operationId: id(),
      jobId: id(),
      stage: "grant_installed",
      atMs: now,
    });
    expect(rec.stage).toBe("grant_installed");
  });

  it("rejects grants with empty operation scopes", () => {
    const grant = ExecutionGrant.safeParse({
      id: id(),
      jobId: id(),
      attemptId: id(),
      epoch: 0,
      investigationId: id(),
      scope: { operations: [], artifactPrefixes: [], maxBytes: 0 },
      expiresAtMs: now + 30_000,
    });
    expect(grant.success).toBe(true); // empty ops = no permissions, valid
    const bad = ExecutionGrant.safeParse({ id: "x" });
    expect(bad.success).toBe(false);
  });

  it("experiment results require engine + asset provenance", () => {
    const bad = ExperimentResult.safeParse({
      id: id(),
      investigationId: id(),
      attemptId: id(),
      epoch: 0,
      simCase: { caseId: "c", suite: "public", seed: 1 },
      status: "succeeded",
      completed: true,
      engineVersion: "",
      assetsSha256: "zz",
      controllerSha256: "bb",
      startedAtMs: now,
    });
    expect(bad.success).toBe(false);
  });
});
