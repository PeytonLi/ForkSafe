import { describe, expect, it, vi } from "vitest";
import { fixtureBackend } from "../src/backend.js";
import { createHandlers, type ForgeContext } from "../src/handlers.js";

const investigationId = "00000000-0000-4000-8000-000000000101";
const candidateId = "00000000-0000-4000-8000-000000000121";
const evaluationId = "00000000-0000-4000-8000-000000000131";
const sha = "a".repeat(64);
const payload = {
  investigationId,
  candidateId,
  evaluationId,
  controllerSha256: sha,
  decision: "approved",
  notes: "Verified against the fixture report.",
};
const context: ForgeContext = {
  accountId: "account-42",
  extension: {
    issue: { key: "FS-42", id: "10042" },
    project: { key: "FS" },
  },
};

describe("Forge review resolver", () => {
  it("takes the reviewer identity from Forge context and records once", async () => {
    const backend = fixtureBackend();
    const recordReview = vi.spyOn(backend, "recordReview");
    const handlers = createHandlers(backend, {
      now: () => 1761200000000,
      newId: () => "00000000-0000-4000-8000-000000000191",
    });
    const result = await handlers.submitReview({ payload, context });
    expect(result).toMatchObject({ ok: true, mode: "fixture" });
    expect(recordReview).toHaveBeenCalledTimes(1);
    expect(recordReview.mock.calls[0]?.[0].review.reviewerIdentity).toBe(
      "atlassian:account-42",
    );
  });

  it("does not record a changed hash, a forged identity, or an unauthenticated review", async () => {
    const backend = fixtureBackend();
    const recordReview = vi.spyOn(backend, "recordReview");
    const handlers = createHandlers(backend);
    const changedHash = await handlers.submitReview({
      payload: { ...payload, controllerSha256: "b".repeat(64) },
      context,
    });
    expect(changedHash).toMatchObject({ ok: false, code: "sha_mismatch" });
    expect(recordReview).not.toHaveBeenCalled();

    const forgedIdentity = await handlers.submitReview({
      payload: { ...payload, reviewerIdentity: "atlassian:attacker" },
      context,
    });
    expect(forgedIdentity).toMatchObject({ ok: false, code: "invalid_request" });
    expect(recordReview).not.toHaveBeenCalled();

    const unauthenticated = await handlers.submitReview({
      payload,
      context: { ...context, accountId: undefined },
    });
    expect(unauthenticated).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(recordReview).not.toHaveBeenCalled();
  });
});
