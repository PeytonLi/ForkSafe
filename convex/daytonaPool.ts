import { Workpool } from "@convex-dev/workpool";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

export const daytonaPool = new Workpool(components.daytonaPool, {
  maxParallelism: Number(process.env.DAYTONA_EXECUTION_CONCURRENCY ?? 3),
});

export const enqueueProvision = internalMutation({
  args: { sandboxOpId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const provision: any = internal.sandboxActions.provision;
    return await daytonaPool.enqueueAction(ctx, provision, args);
  },
});
