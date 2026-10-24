import { describe, expect, it } from "vitest";
import { validateCommand } from "@forksafe/daytona";
import { signedCaseCommand } from "../lib/evaluatorBackend.js";

const base = {
  runDir: "/workspace/runs/eval-6055b5db-a8de-44af-99ee-bef965622250/original-divider-collision",
  controllerSha256: "a".repeat(64), caseId: "original-divider-collision",
  candidateId: "3ab44619-c246-4cc8-be02-ebfe98f2cd50", investigationId: "bd45e46c-eb2d-4fe3-88a4-360aaec1628e",
  attemptId: "6055b5db-a8de-44af-99ee-bef965622250",
};

describe("signedCaseCommand", () => {
  it.each(["public", "withheld"] as const)("is accepted by the evaluator sandbox command policy (%s)", (suite) => {
    const result = validateCommand("evaluator", signedCaseCommand({ ...base, suite }), "/workspace");
    expect(result).toMatchObject({ ok: true });
  });

  it("consumes the uploaded withheld manifest only for the withheld suite", () => {
    expect(signedCaseCommand({ ...base, suite: "withheld" })).toContain("--consume-withheld-manifest");
    expect(signedCaseCommand({ ...base, suite: "public" })).not.toContain("withheld-manifest");
  });

  it("the old chained form is rejected, which is why the command must stay single", () => {
    const chained = `mkdir -p ${base.runDir}/work && ${signedCaseCommand({ ...base, suite: "public" })}`;
    expect(validateCommand("evaluator", chained, "/workspace")).toEqual({ ok: false, reason: "shell_metacharacter" });
  });
});
