import { randomUUID } from "node:crypto";
import { envGet, inlineQuery, runFn } from "../lib/convex.mjs";
import { preflight } from "../lib/scenario.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(ctx) {
  if (!(await preflight(ctx, 0))) return;
  ctx.checks.notReached(
    "B0",
    "SpacetimeDB connectivity is not isolated per runner",
    "the runner never talks to SpacetimeDB; Convex owns the bridge and deployment-wide SPACETIMEDB_URI cannot be changed for one lane",
  );

  const operationId = randomUUID();
  const idempotencyKey = `chaos:blip:${ctx.runId}`;
  const payload = { chaos: true, kind: "chaos_probe", note: "harness probe, expected to fail dispatch" };
  const ingestBody = {
    operationId,
    destination: "elastic_index",
    idempotencyKey,
    payload,
    serviceToken: await envGet("INTEGRATION_SHARED_SECRET"),
  };
  const ingestResponse = await runFn("outbox:ingestFromSpacetime", ingestBody);
  ctx.ids.receiptId = ingestResponse?.receiptId ?? null;
  const observations = [];
  const backoffGapsMs = [];
  let previousAttempt = -1;
  let previousNextAttemptAtMs;
  let sawDelivered = false;
  const deadline = Date.now() + 100_000;
  let row = null;
  while (Date.now() <= deadline) {
    const rowResult = await inlineQuery(`
      const result = await ctx.db.query("outbox")
        .withIndex("by_idempotencyKey", q => q.eq("idempotencyKey", ${JSON.stringify(idempotencyKey)})).unique();
      return { row: result };
    `);
    row = rowResult?.row ?? null;
    if (row) {
      observations.push({
        attempts: row.attempts,
        status: row.status,
        lastError: row.lastError ?? null,
        nextAttemptAtMs: row.nextAttemptAtMs,
      });
      if (row.status === "delivered") sawDelivered = true;
      if (row.attempts !== previousAttempt) {
        if (previousNextAttemptAtMs !== undefined) {
          backoffGapsMs.push(row.nextAttemptAtMs - previousNextAttemptAtMs);
        }
        previousAttempt = row.attempts;
        previousNextAttemptAtMs = row.nextAttemptAtMs;
      }
      if (row.attempts >= 2 && ["pending", "dead"].includes(row.status) && !sawDelivered
        && backoffGapsMs.length >= 2
        && backoffGapsMs.at(-1) > backoffGapsMs.at(-2)) break;
    }
    await sleep(2_000);
  }
  const retryPassed = Boolean(row
    && row.attempts >= 2
    && ["pending", "dead"].includes(row.status)
    && !sawDelivered
    && backoffGapsMs.length >= 2
    && backoffGapsMs.at(-1) > backoffGapsMs.at(-2));
  ctx.checks.check(
    "B1",
    "outbox retry attempts grow with backoff and are not delivered",
    retryPassed,
    { ingestResponse, observations, backoffGapsMs, finalRow: row },
  );

  const repeatedIngest = await runFn("outbox:ingestFromSpacetime", ingestBody);
  const keyRows = await inlineQuery(`
    const rows = await ctx.db.query("outbox")
      .withIndex("by_idempotencyKey", q => q.eq("idempotencyKey", ${JSON.stringify(idempotencyKey)})).collect();
    return { count: rows.length };
  `);
  ctx.checks.check(
    "B2",
    "identical ingest is deduplicated to the same receipt",
    repeatedIngest?.duplicate === true
      && repeatedIngest?.receiptId === ingestResponse?.receiptId
      && keyRows.count === 1,
    { first: ingestResponse, second: repeatedIngest, rowCount: keyRows.count },
  );

  const duplicateKeys = await inlineQuery(`
    const rows = await ctx.db.query("outbox").collect();
    const counts = new Map();
    for (const row of rows) counts.set(row.idempotencyKey, (counts.get(row.idempotencyKey) ?? 0) + 1);
    return { tableSize: rows.length, duplicates: [...counts.entries()].filter(([, count]) => count > 1).map(([idempotencyKey, count]) => ({ idempotencyKey, count })) };
  `);
  ctx.checks.check(
    "B3",
    "global outbox contains no duplicate idempotency keys",
    duplicateKeys.duplicates.length === 0,
    duplicateKeys,
  );

  const firstTick = await runFn("outboxIngest:tick", {});
  const secondTick = await runFn("outboxIngest:tick", {});
  ctx.checks.check(
    "B4",
    "back-to-back SpacetimeDB ingest ticks do not insert duplicates",
    secondTick?.inserted === 0,
    { firstTick, secondTick },
  );
}
