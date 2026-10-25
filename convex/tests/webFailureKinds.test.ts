import { describe, expect, it } from "vitest";
import { webFailureKinds } from "../lib/webFailureKinds.js";

describe("web failure kinds", () => {
  it("keeps known kinds and maps capture-only kinds to invalid_run", () => {
    expect(webFailureKinds(["forbidden_contact", "controller_sha_mismatch"])).toEqual(["forbidden_contact", "invalid_run"]);
    expect(webFailureKinds(undefined)).toEqual([]);
  });
});
