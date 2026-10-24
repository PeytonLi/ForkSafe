import { Client } from "@elastic/elasticsearch";
import { bootstrapIndices } from "../mappings.ts";

const mode = process.env.ELASTIC_MODE ?? "cloud";
const node = process.env.ELASTICSEARCH_URL || (mode === "local" ? "http://127.0.0.1:9200" : undefined);
const apiKey = process.env.ELASTICSEARCH_API_KEY;
let client: Client | undefined;
try {
  if (node && (mode === "local" || (mode === "cloud" && apiKey))) {
    client = new Client({ node, ...(mode === "cloud" ? { auth: { apiKey: apiKey! } } : {}) });
  }
} catch { /* Invalid connection configuration is reported without values below. */ }
if (!client) {
  console.error("Elastic bootstrap unavailable: select a configured cloud or local mode");
  process.exitCode = 1;
} else {
  try { await bootstrapIndices(client); console.log("ForkSafe Elastic indices ready"); }
  catch { console.error("Elastic bootstrap failed"); process.exitCode = 1; }
  finally { await client.close(); }
}
