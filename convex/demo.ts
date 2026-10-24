import { v } from "convex/values";
import { api, internal } from "./_generated/api.js";
import { action } from "./_generated/server.js";

/** `npx convex run demo:seed` — idempotently captures ONE real baseline
 *  failure (the baseline controller run in a Daytona execution sandbox) so a
 *  viewable investigation exists. It never fabricates physics: without
 *  Daytona + published bundles it reports accepted:false with the reason. */
export const seed = action({
  args: { requestedEnvironments: v.optional(v.number()), autoStart: v.optional(v.boolean()), retryFailedCapture: v.optional(v.boolean()), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const idempotencyKey = "demo-seed-v1";
    const outcome = await ctx.runMutation(api.investigations.capture, {
      title: "Demo: Panda collides with divider while carrying the cube",
      seed: 0, sceneOverrides: {}, requestedEnvironments: args.requestedEnvironments ?? 2,
      autoStart: args.autoStart ?? false, idempotencyKey, serviceToken: args.serviceToken,
    });
    if (!outcome.accepted) return { seeded: false, mode: outcome.mode, reason: outcome.reason };
    const investigation = await ctx.runQuery(internal.investigations.getByAppId, { investigationId: outcome.investigationId });
    if (investigation?.captureStatus === "recorded" || (investigation?.captureStatus === "failed" && !args.retryFailedCapture)) {
      return { seeded: investigation.captureStatus === "recorded", duplicate: true, investigationId: outcome.investigationId, state: investigation.state, captureStatus: investigation.captureStatus, mode: "live" };
    }
    const captured = await ctx.runAction(internal.capture.run, { investigationId: outcome.investigationId });
    const refreshed = await ctx.runQuery(internal.investigations.getByAppId, { investigationId: outcome.investigationId });
    return { seeded: captured.recorded, investigationId: outcome.investigationId, baselineExperimentId: captured.experimentId, baselineStatus: captured.status, state: refreshed?.state, mode: "live", ...(captured.error ? { error: captured.error } : {}) };
  },
});
