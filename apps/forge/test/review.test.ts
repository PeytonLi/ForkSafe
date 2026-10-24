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
  submitKey: "00000000-0000-4000-8000-000000000199",
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
    });
    const result = await handlers.submitReview({ payload, context });
    const retry = await handlers.submitReview({ payload, context });
    expect(result).toMatchObject({ ok: true, mode: "fixture" });
    expect(retry).toMatchObject({ ok: true, mode: "fixture" });
    if (!result.ok || !retry.ok) throw new Error("Expected successful reviews");
    expect(retry.data.reviewId).toBe(result.data.reviewId);
    expect(recordReview).toHaveBeenCalledTimes(2);
    expect(recordReview.mock.calls[0]?.[0].review.id).toBe(
      recordReview.mock.calls[1]?.[0].review.id,
    );
    expect(recordReview.mock.calls[0]?.[0].review.reviewerIdentity).toBe(
      "atlassian:account-42",
    );
    const otherAccount = await handlers.submitReview({
      payload,
      context: { ...context, accountId: "account-43" },
    });
    expect(otherAccount.ok).toBe(true);
    if (otherAccount.ok) {
      expect(otherAccount.data.reviewId).not.toBe(result.data.reviewId);
    }
  });

  it("does not record a changed hash, a forged identity, or an unauthenticated review", async () => {
    const backend = fixtureBackend();
    const recordReview = vi.spyOn(backend, "recordReview");
    const handlers = createHandlers(backend);
    const changedHash = await handlers.submitReview({
      payload: { ...payload, controllerSha256: "b".repeat(64) },
      context,
    });
    expect(changedHash).toMatchObject({ ok: false, code: "version_changed" });
    const changedEvaluation = await handlers.submitReview({
      payload: {
        ...payload,
        evaluationId: "00000000-0000-4000-8000-000000000139",
      },
      context,
    });
    expect(changedEvaluation).toMatchObject({
      ok: false,
      code: "version_changed",
    });
    expect(recordReview).not.toHaveBeenCalled();

    const forgedIdentity = await handlers.submitReview({
      payload: { ...payload, reviewerIdentity: "atlassian:attacker" },
      context,
    });
    expect(forgedIdentity).toMatchObject({ ok: false, code: "backend_error" });
    expect(recordReview).not.toHaveBeenCalled();

    const unauthenticated = await handlers.submitReview({
      payload,
      context: { ...context, accountId: undefined },
    });
    expect(unauthenticated).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(recordReview).not.toHaveBeenCalled();
  });

  it("requires a nonblank review note", async () => {
    const handlers = createHandlers(fixtureBackend());
    expect(
      await handlers.submitReview({
        payload: { ...payload, notes: " \n " },
        context,
      }),
    ).toMatchObject({ ok: false, code: "backend_error" });
  });
});
