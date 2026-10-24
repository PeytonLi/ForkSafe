import { v } from "convex/values";
import { internalAction } from "../_generated/server.js";

export const dispatch = internalAction({
  args: { payload: v.any() },
  handler: async () => ({
    delivered: false,
    mode: "not_implemented",
    reason: "owned_by_elastic_lane",
  }),
});
