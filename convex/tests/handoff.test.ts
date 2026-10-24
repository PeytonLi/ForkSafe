import { describe, expect, it } from "vitest";
import { reconcileHandoff, validateStageTransition } from "../lib/handoff.js";

const stages = ["admission_reserved", "grant_installed", "work_started", "artifacts_persisted", "evidence_committed"] as const;
describe("handoff decisions", () => {
  it("enforces order and idempotent duplicate stages", () => {
    expect(validateStageTransition([], "admission_reserved").result).toBe("next");
    expect(validateStageTransition([{ stage: "admission_reserved" }], "admission_reserved").result).toBe("duplicate");
    expect(validateStageTransition([], "work_started").result).toBe("out_of_order");
  });
  it("covers reconcile branches", () => {
    const job = { state: "running", epoch: 1, activeAttemptId: "a" };
    const attempt = { appId: "a", epoch: 1, leasedUntilMs: 100, startedAtMs: 0 };
    const run = (s: string[], now = 50, jobState = "running", a: typeof attempt | null = attempt) =>
      reconcileHandoff({ job: { ...job, state: jobState }, attempt: a, stages: s.map((stage) => ({ stage: stage as any })), now, grantInstallTimeoutMs: 10 });
    expect(run([], 0).action).toBe("none");
    expect(run(["admission_reserved", "evidence_committed"]).action).toBe("inconsistent");
    expect(run([...stages]).action).toBe("acknowledge_completion");
    expect(run(["admission_reserved", "grant_installed", "work_started", "artifacts_persisted"]).action).toBe("await_evidence_commit");
    expect(run(["admission_reserved", "grant_installed", "work_started", "artifacts_persisted"], 101).action).toBe("retry_evidence_commit");
    expect(run(["admission_reserved", "grant_installed", "work_started"], 101).action).toBe("expire_attempt");
    expect(run(["admission_reserved"], 11).action).toBe("grant_install_timeout");
    expect(run([...stages, "completion_acknowledged"], 50, "succeeded").action).toBe("none");
  });
});
