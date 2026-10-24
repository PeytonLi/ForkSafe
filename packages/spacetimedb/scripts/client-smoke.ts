import { decodeLiveCandidates, decodeLiveFindings } from "../client/decoders.js";
import { connectForkSafe, subscribeInvestigation } from "../client/index.js";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const findingId = process.env.SMOKE_FINDING_ID;
const investigationId = process.env.SMOKE_INVESTIGATION_ID;
const candidateId = process.env.SMOKE_CANDIDATE_ID;

if (!uri || !database || !findingId || !investigationId || !candidateId) {
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
    const findingRows = [...connected.conn.db.finding.iter()];
    const evidence = [...connected.conn.db.evidence.iter()];
    const tombstones = [...connected.conn.db.tombstone.iter()];
    const liveFindings = decodeLiveFindings(findingRows, evidence, tombstones);
    if (liveFindings.live.some((row) => row.id === findingId)) {
      throw new Error("Tombstoned finding remained in the decoded live findings");
    }
    if (!liveFindings.revoked.some((row) => row.findingId === findingId)) {
      throw new Error("Tombstoned finding reason was not decoded");
    }
    const liveCandidates = decodeLiveCandidates(
      [...connected.conn.db.candidate.iter()],
      [...connected.conn.db.evaluation.iter()],
      [...connected.conn.db.humanReview.iter()],
      tombstones,
    );
    if (!liveCandidates.revoked.some((row) => row.candidateId === candidateId)) {
      throw new Error("Candidate source tombstone was not decoded");
    }
    console.log("PASS TypeScript client connected, subscribed, and decoded live/revoked rows");
  } finally {
    subscription.unsubscribe();
  }
} finally {
  connected.conn.disconnect();
}
