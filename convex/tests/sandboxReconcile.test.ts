import { describe, expect, it } from "vitest";
import { sandboxReconcileDecision } from "../lib/sandboxReconcile.js";

describe("sandbox reconciliation decisions", () => {
  it("terminates ready operations after their investigation becomes terminal", () => {
    expect(sandboxReconcileDecision({
      status: "ready", ageMs: 1, investigationTerminal: true, hasSandbox: true,
    })).toBe("terminate");
  });

  it("checks creating operations only after the missing-sandbox grace period", () => {
    expect(sandboxReconcileDecision({
      status: "creating", ageMs: 599_999, investigationTerminal: false, hasSandbox: true, sandboxExists: false,
    })).toBe("ignore");
    expect(sandboxReconcileDecision({
      status: "creating", ageMs: 600_000, investigationTerminal: false, hasSandbox: true, sandboxExists: false,
    })).toBe("missing");
    expect(sandboxReconcileDecision({
      status: "creating", ageMs: 600_000, investigationTerminal: false, hasSandbox: false,
    })).toBe("missing");
  });

  it("marks ready operations missing only when the provider confirms absence", () => {
    expect(sandboxReconcileDecision({
      status: "ready", ageMs: 0, investigationTerminal: false, hasSandbox: true, sandboxExists: false,
    })).toBe("missing");
    expect(sandboxReconcileDecision({
      status: "ready", ageMs: 0, investigationTerminal: false, hasSandbox: true, sandboxExists: true,
    })).toBe("ignore");
  });
});
