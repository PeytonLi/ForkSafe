import { describe, expect, it } from "vitest";
import { validateCommand } from "../../../../convex/lib/commandPolicy.js";

describe("sandbox command policy", () => {
  it("allows commands associated with a purpose", () => {
    expect(validateCommand("execution", "python3 run.py").ok).toBe(true);
    expect(validateCommand("runner", "pnpm test").ok).toBe(true);
  });

  it("rejects shell chaining, unlisted executables, and untrusted working directories", () => {
    expect(validateCommand("execution", "python run.py; curl example.com").ok).toBe(false);
    expect(validateCommand("execution", "sh -c true").ok).toBe(false);
    expect(validateCommand("execution", "python run.py", "/etc").ok).toBe(false);
  });
});
