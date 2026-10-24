import { describe, expect, it } from "vitest";
import { mayWrite } from "./browserAccess";

describe("browser write gating", () => {
  it("requires a session in convex mode but leaves fixtures unchanged", () => {
    expect(mayWrite("convex", false)).toBe(false);
    expect(mayWrite("convex", true)).toBe(true);
    expect(mayWrite("convex", true, false)).toBe(false);
    expect(mayWrite("fixture", false)).toBe(true);
  });
});
