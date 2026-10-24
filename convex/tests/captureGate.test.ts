import { describe, expect, it } from "vitest";
import { shouldStartAgents } from "../lib/captureGate.js";

describe("shouldStartAgents", () => {
  it("starts agents only for a real baseline failure", () => {
    expect(shouldStartAgents({ completed: true, failureKinds: [] })).toBe(false);
    expect(shouldStartAgents({ completed: false, failureKinds: [] })).toBe(true);
    expect(shouldStartAgents({ completed: false, failureKinds: ["timeout"] })).toBe(true);
    expect(shouldStartAgents({ completed: true, failureKinds: ["timeout"] })).toBe(true);
    expect(shouldStartAgents({ completed: false, failureKinds: ["forbidden_contact"] })).toBe(true);
    expect(shouldStartAgents({ completed: true, failureKinds: ["missing_artifact"] })).toBe(false);
    expect(shouldStartAgents({ completed: false, failureKinds: ["invalid_run"] })).toBe(false);
    expect(shouldStartAgents({ completed: false, failureKinds: ["engine_error"] })).toBe(false);
  });
});
