import { v } from "convex/values";
import { internalMutation } from "../_generated/server.js";

export const deadLetter = internalMutation({
  args: { idempotencyKey: v.string(), errorCode: v.string() },
  handler: async (ctx, args) => {
    const entry = await ctx.db.query("outbox")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (!entry || entry.status === "delivered") return { updated: false };
    if (entry.status === "pending") {
      await ctx.db.patch(entry._id, { status: "dead", lastError: args.errorCode });
    }
    return { updated: true };
  },
});
