import { describe, expect, it } from "vitest";
import { HttpJobSource, isSearchCompleteRevocation, RunnerHttpError } from "../src/job-source.js";

describe("runner revoked credential shutdown", () => {
  it("recognizes the revoked credential response used after search completion", async () => {
    const source = new HttpJobSource(
      "https://runner.invalid",
      "secret",
      async () => new Response(JSON.stringify({ error: "unauthorized", reason: "credential_revoked" }), { status: 401 }),
    );
    const error = await source.claim({ workerId: "test", kinds: ["factory_session"], capacity: 1 })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RunnerHttpError);
    expect(isSearchCompleteRevocation(error)).toBe(true);
  });

  it("does not treat a generic unauthorized response as a clean shutdown", async () => {
    const source = new HttpJobSource(
      "https://runner.invalid",
      "secret",
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    const error = await source.claim({ workerId: "test", kinds: ["factory_session"], capacity: 1 })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RunnerHttpError);
    expect(isSearchCompleteRevocation(error)).toBe(false);
  });
});
