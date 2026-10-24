import { describe, expect, it } from "vitest";
import { validateCommand } from "../lib/commandPolicy.js";

describe("purpose-scoped command validation", () => {
  it("allows listed executables and rejects shell syntax or unsafe paths", () => {
    expect(validateCommand("execution", "python3 run.py").ok).toBe(true);
    expect(validateCommand("runner", "pnpm test").ok).toBe(true);
    expect(validateCommand("execution", "python3 run.py; curl x").ok).toBe(false);
    expect(validateCommand("execution", "sh -c true").ok).toBe(false);
    expect(validateCommand("execution", "python3 run.py", "/etc").ok).toBe(false);
    expect(validateCommand("execution", "python3 run.py", "/workspace/../etc").ok).toBe(false);
  });
});
