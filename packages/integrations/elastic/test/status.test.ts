import { describe, expect, it, vi } from "vitest";
import { INDEX_ERRORS_INDEX, INDICES, diffProjections, fixtureStatus, indexErrorRecords, reconcile, reconcileProjections, recordIndexErrors, status,
  type IndexResult, type StatusClient } from "../src/index.ts";

const inv = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const failed: IndexResult[] = [
  { id: "f1", index: INDICES.finding, result: "created" },
  { id: "e1", index: INDICES.evidence, result: "error", errorType: "permanent", errorCode: "mapper_parsing_exception", status: 400 },
  { id: "x1", index: INDICES.experiment_result, result: "error" },
];
const ctx = { idempotencyKey: "delivery-1", attempt: 2, now: 1000, investigationId: inv };
const notFound = () => Object.assign(new Error("nf"), { meta: { statusCode: 404 } });
const projection = (docType: keyof typeof INDICES, id: string, sourceVersion = "v1", investigationId = inv, indexedAt = 10) =>
  ({ index: INDICES[docType], id, body: { docType, id, sourceVersion, investigationId, indexedAt } }) as never;

describe("index error log", () => {
  it("records only failed results with stable ids per delivery attempt", () => {
    const records = indexErrorRecords(failed, ctx);
    expect(records.map(r => r.docId)).toEqual(["e1", "x1"]);
    expect(records[0]).toMatchObject({ errorType: "permanent", errorCode: "mapper_parsing_exception", status: 400, attempt: 2, investigationId: inv });
    expect(records[1]!.errorType).toBe("transient");
    expect(indexErrorRecords(failed, ctx).map(r => r.id)).toEqual(records.map(r => r.id));
    expect(indexErrorRecords(failed, { ...ctx, attempt: 3 })[0]!.id).not.toBe(records[0]!.id);
    expect(() => indexErrorRecords(failed, { ...ctx, idempotencyKey: "" })).toThrow();
  });
  it("persists by stable _id so retries overwrite, and fails loudly on partial or transport failures", async () => {
    const bulk = vi.fn().mockResolvedValue({ errors: false, items: [{ index: { status: 201 } }, { index: { status: 201 } }] });
    expect(await recordIndexErrors({ bulk }, failed, ctx)).toBe(2);
    const ops = bulk.mock.calls[0]![0].operations;
    expect(ops[0]).toEqual({ index: { _index: INDEX_ERRORS_INDEX, _id: indexErrorRecords(failed, ctx)[0]!.id } });
    expect(await recordIndexErrors({ bulk }, failed.slice(0, 1), ctx)).toBe(0);
    expect(bulk).toHaveBeenCalledTimes(1);
    await expect(recordIndexErrors({ bulk: vi.fn().mockResolvedValue({ errors: true, items: [{ index: { status: 201 } }, { index: { status: 429, error: {} } }] }) }, failed, ctx))
      .rejects.toThrow("1 record");
    const secret = "https://user:pw@es.invalid";
    const error = await recordIndexErrors({ bulk: vi.fn().mockRejectedValue(new Error(secret)) }, failed, ctx).catch(e => e);
    expect(error.message).not.toContain(secret);
  });
});

describe("status", () => {
  const client = (overrides: Partial<Record<string, unknown>> = {}): StatusClient => ({
    count: vi.fn(async ({ index }) => {
      if (overrides[`count:${index}`] instanceof Error) throw overrides[`count:${index}`];
      return { count: index === INDICES.finding ? 4 : 0 } as never;
    }),
    search: vi.fn(async ({ index }) => {
      if (index === INDEX_ERRORS_INDEX) {
        if (overrides.errors instanceof Error) throw overrides.errors;
        return { hits: { total: { value: 1, relation: "eq" }, hits: overrides.errors === "none" ? [] : [{ _source: indexErrorRecords(failed, ctx)[0] }] } } as never;
      }
      return { hits: { hits: [] }, aggregations: { lastIndexedAt: { value: index === INDICES.finding ? 900 : null } } } as never;
    }),
  });
  it("reports counts, last indexed time, lag and recent errors", async () => {
    const result = await status(client(), { now: 1000 });
    const finding = result.indices.find(i => i.index === INDICES.finding)!;
    expect(finding).toMatchObject({ exists: true, docCount: 4, lastIndexedAt: 900, ageMs: 100 });
    expect(result.indices.find(i => i.index === INDICES.evidence)).toMatchObject({ docCount: 0, lastIndexedAt: null, ageMs: null });
    expect(result.errors).toMatchObject({ state: "ok", total: 1 });
    expect(result.errors.recent[0]!.docId).toBe("e1");
    expect(result).toMatchObject({ mode: "live", healthy: false });
    expect((await status(client({ errors: "none" }), { now: 1000 })).healthy).toBe(true);
  });
  it("distinguishes missing from unavailable indices and never reports them healthy", async () => {
    const result = await status(client({ [`count:${INDICES.evidence}`]: notFound(), [`count:${INDICES.candidate}`]: new Error("503 secret"), errors: notFound() }), { now: 1000 });
    expect(result.indices.find(i => i.index === INDICES.evidence)).toMatchObject({ exists: false, docCount: null, error: "missing; run bootstrap" });
    expect(result.indices.find(i => i.index === INDICES.candidate)).toMatchObject({ exists: true, docCount: null, error: "unavailable" });
    expect(result.errors).toMatchObject({ state: "missing", total: null });
    expect(result.healthy).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("fixture status mirrors the live shape from in-memory data", () => {
    const errors = indexErrorRecords(failed, ctx);
    const result = fixtureStatus([projection("finding", "a", "v1", inv, 5), projection("finding", "b", "v1", inv, 7)], errors, 10, 1);
    expect(result.indices.find(i => i.index === INDICES.finding)).toMatchObject({ docCount: 2, lastIndexedAt: 7, ageMs: 3 });
    expect(result).toMatchObject({ mode: "fixture", healthy: false, errors: { total: 2 } });
    expect(result.errors.recent).toHaveLength(1);
  });
});

describe("reconcile", () => {
  const canon = (docType: "finding" | "evidence" | "experiment_result", id: string, sourceVersion = "v1", investigationId = inv) => ({ docType, id, sourceVersion, investigationId });
  it("reports missing, extra, stale, scope mismatches and duplicates", () => {
    const report = reconcileProjections(
      [canon("finding", "ok"), canon("finding", "missing"), canon("evidence", "old", "v2"), canon("finding", "moved")],
      [projection("finding", "ok"), projection("evidence", "old", "v1"), projection("finding", "extra"), projection("finding", "moved", "v1", other),
        projection("finding", "unrelated", "v1", other)]);
    expect(report.missing.map(m => m.id)).toEqual(["missing"]);
    expect(report.extra.map(m => m.id)).toEqual(["extra"]);
    expect(report.stale).toEqual([{ docType: "evidence", id: "old", canonicalVersion: "v2", indexedVersion: "v1" }]);
    expect(report.scopeMismatch).toEqual([{ docType: "finding", id: "moved", canonicalInvestigationId: inv, indexedInvestigationId: other }]);
    expect(report.inSync).toBe(false);
    const dup = diffProjections([canon("finding", "a")], [{ ...canon("finding", "a") }, { ...canon("finding", "a") }]);
    expect(dup.duplicates).toEqual([{ docType: "finding", id: "a", copies: 2 }]);
    expect(reconcileProjections([canon("finding", "ok")], [projection("finding", "ok")]).inSync).toBe(true);
  });
  it("treats the same id under different docTypes as distinct and rejects bad canonical input", () => {
    expect(reconcileProjections([canon("finding", "a")], [projection("evidence", "a")])).toMatchObject({ missing: [{ id: "a" }], extra: [{ id: "a" }] });
    expect(() => reconcileProjections([canon("finding", "a"), canon("finding", "a")], [])).toThrow("Duplicate");
    expect(() => reconcileProjections([{ ...canon("finding", "a"), extra: 1 } as never], [])).toThrow();
    expect(() => reconcileProjections([{ ...canon("finding", "a"), docType: "review" } as never], [])).toThrow();
  });
  it("an empty canonical list for a scope reports every indexed doc as extra", () => {
    expect(reconcileProjections([], [projection("finding", "a")], [inv]).extra.map(e => e.id)).toEqual(["a"]);
  });
  it("pages with search_after, flags truncation, scopes the query and hides transport errors", async () => {
    const pages = [[canon("finding", "a")], [canon("finding", "b")], [canon("finding", "c")]];
    const search = vi.fn(async () => ({ hits: { hits: (pages.shift() ?? []).map((s, i) => ({ _source: s, sort: [s.docType, s.id, i] })) } }) as never);
    const report = await reconcile([canon("finding", "a"), canon("finding", "b")], { search }, { pageSize: 1, maxDocs: 2 });
    expect(report).toMatchObject({ mode: "live", truncated: true, inSync: false });
    const second = (search.mock.calls as unknown as [Record<string, unknown>][])[1]![0];
    expect(second.search_after).toEqual(["finding", "a", 0]);
    expect(JSON.stringify(second.query)).toContain(inv);
    await expect(reconcile([], { search })).rejects.toThrow("investigation scope");
    await expect(reconcile([canon("finding", "a")], { search: vi.fn().mockRejectedValue(new Error("https://es.invalid key")) })).rejects.toThrow(/^Elastic reconcile query failed$/);
  });
});
