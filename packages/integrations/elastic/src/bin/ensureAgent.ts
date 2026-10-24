import { resolveConfig } from "../config.ts";
import { ensureAgent } from "../evidenceAgent.ts";
import { redactTranscript } from "../agentSmoke.ts";

const env = resolveConfig();
try { console.log(redactTranscript(await ensureAgent(env), env)); }
catch (error) {
  console.error(redactTranscript({ mode: "blocked", error: error instanceof Error ? `${error.name}: ${error.message}` : "ensureAgent failed" }, env));
  process.exitCode = 1;
}
