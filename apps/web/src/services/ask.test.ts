import type { Finding } from "@forksafe/contracts";
import { describe, expect, it } from "vitest";
import { citationTime, fixtureAnswer, scopedQuestion, withheldReason } from "./ask";
import { FixtureClient } from "./fixtureClient";

const INV = "3b7d9303-7082-4b73-a3b6-1391b3e2fc4d";
const OTHER = "9e9efe34-0000-4000-8000-000000000000";
const client = () => new FixtureClient({ latencyMs: 0, storage: null });

describe("scopedQuestion", () => {
  it("normalizes whitespace and keeps in-scope ids", () => {
    expect(scopedQuestion("  why   did it\nfail?  ", INV)).toBe("why did it fail?");
    expect(scopedQuestion(`what happened in ${INV}?`, INV)).toContain(INV);
  });
  it.each([
    ["", "invalid_input"],
    ["hi", "invalid_input"],
    ["x".repeat(501), "invalid_input"],
    ["why\u0007", "invalid_input"],
    ["compare all investigations", "out_of_scope"],
    [`what did ${OTHER} find?`, "out_of_scope"],
  ])("rejects %j", (q, code) => {
    expect(() => scopedQuestion(q, INV)).toThrow(expect.objectContaining({ code }));
  });
});

describe("fixture answers", () => {
  it("cites real recorded findings for a suggested question and flags the recorded revoked source", async () => {
    const a = await client().askEvidence(INV, "Why did the cube hit the divider?");
    expect(a.mode).toBe("fixture");
    expect(a.enoughEvidence).toBe(true);
    expect(a.label).toMatch(/not used/);
    const findings = await client().listFindings(INV);
    const ids = new Set(findings.map((f) => f.id));
    expect(a.citations.length).toBeGreaterThan(0);
    for (const c of a.citations) expect(ids.has(c.id)).toBe(true);
    expect(a.withheld).toEqual([expect.objectContaining({ reason: "revoked" })]);
    expect(ids.has(a.withheld[0]!.id)).toBe(false);
  });

  it("copies a locator time onto the citation and omits tSec when the evidence has none", () => {
    const env = "e95d4081-af90-49fb-afb3-f445b6504d97";
    const timed = {
      id: "11111111-1111-4111-8111-111111111111",
      investigationId: INV,
      environmentId: env,
      kind: "collision_frame",
      summary: "The cube hit the divider.",
      evidence: [{ kind: "contact_event", locator: { tSec: 1.8 } }],
      createdAtMs: 2,
    } satisfies Finding;
    const plain = {
      id: "22222222-2222-4222-8222-222222222222",
      investigationId: INV,
      environmentId: env,
      kind: "behavioral_note",
      summary: "The cube hit the divider at 9.9 seconds.",
      evidence: [{ kind: "log_excerpt", locator: { frame: 3 } }],
      createdAtMs: 1,
    } satisfies Finding;
    const a = fixtureAnswer([timed, plain], "Why did the cube hit the divider?");
    expect(a.citations.find((c) => c.id === timed.id)?.tSec).toBe(1.8);
    expect(a.citations.find((c) => c.id === plain.id)).not.toHaveProperty("tSec");
    expect(citationTime({
      ...timed,
      evidence: [
        { kind: "metric", locator: { timeSec: 4.4, tSec: Number.NaN } },
        { kind: "contact_event", locator: { failureTSec: 2.2, tSec: "9.9" } },
        { kind: "trace_frame", locator: { tSec: 1.8 } },
      ],
    })).toBe(1.8);
    expect(citationTime(plain)).toBeUndefined();
  });

  it("says when the evidence doesn't cover a question instead of guessing", () => {
    const a = fixtureAnswer([], "What is the weather on Mars?");
    expect(a).toMatchObject({ enoughEvidence: false, citations: [], withheld: [] });
    expect(a.answer).toBeUndefined();
  });

  it("refuses restricted investigations and other-investigation ids", async () => {
    await expect(client().askEvidence(INV, `what did ${OTHER} find?`)).rejects.toMatchObject({ code: "out_of_scope" });
    const list = await client().listInvestigations();
    const restricted = list.find((i) => i.state === "restricted")!;
    await expect(client().askEvidence(restricted.id, "why did it fail?")).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("explains every validation reason in plain words", () => {
    for (const r of ["revoked", "stale", "out_of_scope", "unauthorized", "unknown_reason"]) expect(withheldReason(r)).not.toMatch(/_/);
  });
});

describe("fixture pipeline and handoffs", () => {
  it("derives pipeline counts from recorded environments with no invented outbox rows", async () => {
    const p = await client().getPipelineHealth();
    expect(p).toMatchObject({ mode: "fixture", sandboxCap: 5, outboxBacklog: 0, outboxDead: 0 });
    expect(p.activeSandboxes).toBeLessThanOrEqual(p.sandboxCap);
  });
  it("reconstructs ordered handoff steps only for this investigation's experiments", async () => {
    const hs = await client().listHandoffs(INV);
    const ws = await client().getWorkspace(INV);
    const envs = new Set(ws.environments.map((e) => e.id));
    expect(hs.length).toBeGreaterThan(0);
    for (const h of hs) expect(envs.has(h.environmentId!)).toBe(true);
    const job = hs.filter((h) => h.jobId === hs[0]!.jobId).map((h) => h.stage);
    expect(job[0]).toBe("admission_reserved");
  });
});
