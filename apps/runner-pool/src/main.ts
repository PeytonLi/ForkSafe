import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerPool } from "./pool.js";

const here = dirname(fileURLToPath(import.meta.url));

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("POOL_MAX_RUNNERS must be a positive integer");
  return parsed;
}

export async function main(): Promise<void> {
  const convexSiteUrl = process.env.CONVEX_SITE_URL;
  const token = process.env.RUNNER_POOL_TOKEN;
  if (!convexSiteUrl || !token) throw new Error("CONVEX_SITE_URL and RUNNER_POOL_TOKEN are required");
  const pool = new RunnerPool({
    convexSiteUrl,
    token,
    maxRunners: positiveInteger(process.env.POOL_MAX_RUNNERS, 4),
    runnerEntryPoint: process.env.RUNNER_ENTRYPOINT ?? resolve(here, "../../runner/dist/runner.mjs"),
  });
  await pool.start(positiveInteger(process.env.PORT, 8080));
  const stop = () => { void pool.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
