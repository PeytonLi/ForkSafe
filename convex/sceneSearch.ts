import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { isTaskFamily, validateSceneOverrides } from "@forksafe/contracts";
import { requireWriteIdentity } from "./lib/webAccess.js";
import type { FailureSearchResult } from "./lib/sceneSearch.js";
import { appId } from "./lib/validators.js";

type FindFailureResponse = FailureSearchResult | {
  mode: "local" | "blocked";
  found: false;
  samples: number;
  failures: number;
  reason: string;
};

export const findFailure = action({
  args: {
    taskFamily: v.string(),
    serviceToken: v.optional(v.string()),
    sceneOverrides: v.optional(v.record(v.string(), v.number())),
    seed: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<FindFailureResponse> => {
    await requireWriteIdentity(ctx, args.serviceToken);
    if (args.sceneOverrides !== undefined) {
      const validation = validateSceneOverrides(args.taskFamily, args.sceneOverrides);
      if (!validation.ok) {
        return { mode: "live" as const, found: false as const, samples: 0, failures: 0, reason: validation.reason };
      }
    }
    if (!isTaskFamily(args.taskFamily)) {
      return { mode: "live" as const, found: false as const, samples: 0, failures: 0, reason: `Unknown task "${args.taskFamily}".` };
    }
    if (process.env.DAYTONA_MODE !== "cloud" || !process.env.DAYTONA_API_KEY) {
      return {
        mode: process.env.DAYTONA_MODE === "local" ? "local" as const : "blocked" as const,
        found: false as const,
        samples: 0,
        failures: 0,
        reason: "Finding a failure needs a Daytona sandbox; DAYTONA_API_KEY is not configured.",
      };
    }
    const simulator = await ctx.runQuery(internal.bundles.get, { key: "simulator" });
    const baseline = await ctx.runQuery(internal.bundles.get, { key: "baseline_controller" });
    if (!simulator || !baseline) {
      return {
        mode: "blocked" as const,
        found: false as const,
        samples: 0,
        failures: 0,
        reason: "The simulator and baseline controller bundles must be published before searching.",
      };
    }
    const source = await ctx.runQuery(internal.evidence.getSourceBySha, { controllerSha256: baseline.sha256 });
    if (!source) {
      return {
        mode: "blocked" as const,
        found: false as const,
        samples: 0,
        failures: 0,
        reason: "The baseline controller source is unavailable.",
      };
    }
    const searchId = appId();
    try {
      return await ctx.runAction(internal.execution.runFuzz, {
        searchId,
        taskFamily: args.taskFamily,
        seed: args.seed ?? 1,
        controllerSource: source.source,
        ...(args.sceneOverrides !== undefined ? { centerOverrides: args.sceneOverrides } : {}),
      });
    } catch (error) {
      const reason = error instanceof ConvexError ? String(error.data) : "Failure search could not run.";
      return { mode: "live" as const, found: false as const, samples: 0, failures: 0, reason };
    }
  },
});
