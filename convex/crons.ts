import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("reconcile", { seconds: 5 }, internal.reconcile.tick, {});
crons.interval("sandbox-reconcile", { minutes: 2 }, internal.sandboxActions.reconcileSandbox, {});
crons.interval("outbox-ingest", { seconds: 30 }, internal.outboxIngest.tick, {});

export default crons;
