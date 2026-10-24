import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { SpacetimeClient, spacetimeEnvironment } from "./dispatchers/spacetime.js";
import { spacetimeConfig } from "./lib/spacetime.js";

const DESTINATIONS = ["elastic_index", "jira_sync", "confluence_link"] as const;
type Destination = (typeof DESTINATIONS)[number];
export const INGEST_BATCH = 100;

export type IngestEntry = { destination: Destination; idempotencyKey: string; operationId: string; payload: Record<string, unknown> };

/** Maps pending SpacetimeDB outbox_entry rows to Convex outbox inserts. The
 *  module's idempotency key is reused, so repeated ticks never duplicate. */
export function toIngestEntries(rows: Record<string, unknown>[]): { entries: IngestEntry[]; skipped: number } {
  const entries: IngestEntry[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.status !== "pending") continue;
    const destination = row.destination as Destination;
    const key = row.idempotencyKey;
    const operationId = row.operationId;
    let payload: unknown;
    try {
      payload = typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson) : undefined;
    } catch {
      payload = undefined;
    }
    if (!DESTINATIONS.includes(destination) || typeof key !== "string" || key.length < 8 || typeof operationId !== "string"
      || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      skipped += 1;
      continue;
    }
    entries.push({ destination, idempotencyKey: key, operationId, payload: payload as Record<string, unknown> });
  }
  entries.sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
  return { entries, skipped };
}

export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    mode: string;
    inserted: number;
    duplicates: number;
    skipped: number;
    failed: number;
    reconciliation: { checked: number; committed: number; pending: number; failed: number; notApplicable: number };
  }> => {
    const config = spacetimeConfig(process.env);
    const emptyReconciliation = { checked: 0, committed: 0, pending: 0, failed: 0, notApplicable: 0 };
    if (config.mode !== "live" && config.mode !== "local") {
      return { mode: config.mode, inserted: 0, duplicates: 0, skipped: 0, failed: 0, reconciliation: emptyReconciliation };
    }
    const reconciliation = await ctx.runAction(internal.evaluationReconcile.reconcilePendingCommits, {});
    const token = await ctx.runAction(internal.bridge.sharedBridgeToken, {});
    const client = new SpacetimeClient(spacetimeEnvironment(token));
    const rows = await client.sql("SELECT * FROM outbox_entry WHERE status = 'pending'");
    const { entries, skipped } = toIngestEntries(rows);
    let inserted = 0;
    let duplicates = 0;
    let failed = 0;
    for (const entry of entries.slice(0, INGEST_BATCH)) {
      try {
        const result = await ctx.runMutation(internal.outbox.insert, { ...entry, source: "spacetimedb" });
        if (result.duplicate) duplicates += 1;
        else inserted += 1;
      } catch {
        failed += 1;
      }
    }
    return { mode: config.mode, inserted, duplicates, skipped, failed, reconciliation };
  },
});
