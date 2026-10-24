import { appendFileSync } from "node:fs";
import { redactSecrets } from "./lib/convex.mjs";

const file = process.env.CHAOS_PROBE_FILE;

function record(ev: "acquired" | "released"): void {
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ t: Date.now(), ev })}\n`);
}

async function runRunner(): Promise<void> {
  try {
    const { SessionManager } = await import("../../packages/agents/src/index.ts");
    const prototype = SessionManager.prototype as unknown as Record<string, (...args: any[]) => any>;
    const originalAcquire = prototype.acquire;
    const originalTryAcquire = prototype.tryAcquire;
    const originalRelease = prototype.release;
    if (typeof originalAcquire !== "function" || typeof originalTryAcquire !== "function" || typeof originalRelease !== "function") {
      throw new Error("SessionManager turn methods are unavailable");
    }

    prototype.acquire = function (...args: any[]) {
      const result = originalAcquire.apply(this, args);
      return Promise.resolve(result).then((value) => {
        record("acquired");
        return value;
      });
    };
    prototype.tryAcquire = function (...args: any[]) {
      const acquired = originalTryAcquire.apply(this, args);
      if (acquired) record("acquired");
      return acquired;
    };
    prototype.release = function (...args: any[]) {
      const result = originalRelease.apply(this, args);
      record("released");
      return result;
    };

    const { main } = await import("../../apps/runner/src/main.ts");
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${redactSecrets(message)}\n`);
    process.exitCode = 1;
  }
}

void runRunner();
