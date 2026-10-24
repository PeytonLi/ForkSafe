import { decodeFinding } from "../client/decoders.js";
import { connectForkSafe, subscribeInvestigation } from "../client/index.js";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const findingId = process.env.SMOKE_FINDING_ID;
const investigationId = process.env.SMOKE_INVESTIGATION_ID;

if (!uri || !database || !findingId || !investigationId) {
  throw new Error("Client smoke environment is incomplete");
}

const connected = await connectForkSafe({ uri, database });
try {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const subscription = await Promise.race([
    subscribeInvestigation(connected.conn, investigationId),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Finding subscription timed out")), 15_000);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  try {
    const row = connected.conn.db.finding.id.find(findingId);
    if (!row) throw new Error("Subscribed finding was not present in the client cache");
    const evidence = [...connected.conn.db.evidence.iter()];
    decodeFinding(row, evidence);
    console.log("PASS TypeScript client connected, subscribed, and decoded finding");
  } finally {
    subscription.unsubscribe();
  }
} finally {
  connected.conn.disconnect();
}
