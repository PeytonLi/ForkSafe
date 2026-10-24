import { query } from "./_generated/server.js";
import { EnvConfig, IntegrationReadiness, effectiveMode } from "@forksafe/contracts";
import { readLimits } from "./lib/constants.js";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const env = EnvConfig.parse(process.env);
    const flag = await ctx.db.query("systemFlags")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    const checkedAtMs = Date.now();
    const readiness = [
      IntegrationReadiness.parse({
        name: "convex",
        mode: "live",
        detail: "Convex functions are serving requests",
        checkedAtMs,
      }),
      IntegrationReadiness.parse({
        name: "daytona",
        mode: effectiveMode(env, "DAYTONA_MODE"),
        detail: env.DAYTONA_MODE === "local"
          ? "local docker adapter — hosted actions require a local worker"
          : env.DAYTONA_API_KEY ? "cloud API key configured" : "DAYTONA_API_KEY is missing",
        checkedAtMs,
      }),
      IntegrationReadiness.parse({
        name: "artifact_store",
        mode: env.ARTIFACT_MODE === "cloud" ? "live" : "local",
        detail: env.ARTIFACT_MODE === "cloud" ? "Convex file storage" : "local filesystem adapter",
        checkedAtMs,
      }),
    ];
    return {
      ready: readiness.every((item) => item.mode === "live" || item.mode === "local"),
      readiness,
      limits: readLimits(),
      admissionPaused: flag?.admissionPaused ?? false,
      pausedReason: flag?.pausedReason,
    };
  },
});
