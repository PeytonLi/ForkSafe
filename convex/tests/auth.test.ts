import { describe, expect, it } from "vitest";
import { constantTimeEqual, requireServiceToken, requireUiAccess } from "../lib/auth.js";

describe("service and UI authorization", () => {
  it("compares tokens and fails closed when no secret is configured", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("secret", "secreu")).toBe(false);
    expect(() => requireServiceToken("token", undefined)).toThrow("unauthorized");
    expect(() => requireServiceToken("wrong", "right")).toThrow("unauthorized");
    expect(() => requireServiceToken("right", "right")).not.toThrow();
  });
  it("allows anonymous UI only when explicitly enabled", () => {
    expect(() => requireUiAccess(undefined, {})).toThrow("unauthorized");
    expect(() => requireUiAccess(undefined, { FORKSAFE_DEV_ANONYMOUS_UI: "true" })).not.toThrow();
  });
});
