import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { validateCommand } from "./lib/commandPolicy.js";
import { LOG_TAIL_MAX_BYTES } from "./lib/constants.js";
import { appId } from "./lib/validators.js";

export const authorizeCommand = internalQuery({
  args: {
    jobId: v.string(),
    attemptId: v.string(),
    epoch: v.number(),
    sandboxOpId: v.string(),
    command: v.string(),
    cwd: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.query("jobs").withIndex("by_appId", (q) => q.eq("appId", args.jobId)).unique();
    const attempt = await ctx.db.query("attempts").withIndex("by_appId", (q) => q.eq("appId", args.attemptId)).unique();
    const op = await ctx.db.query("sandboxOps").withIndex("by_appId", (q) => q.eq("appId", args.sandboxOpId)).unique();
    if (!job || !attempt || !op) throw new ConvexError("sandbox_command_not_authorized");
    if (job.activeAttemptId !== attempt.appId || job.epoch !== args.epoch || attempt.epoch !== args.epoch ||
        attempt.jobId !== job.appId || op.status !== "ready" ||
        (job.environmentId && op.environmentId !== job.environmentId)) {
      throw new ConvexError("sandbox_command_fenced");
    }
    const result = validateCommand(op.purpose, args.command, args.cwd);
    if (!result.ok) throw new ConvexError(result.reason);
    return { ref: op.sandbox, purpose: op.purpose };
  },
});

export const saveCommand = internalMutation({
  args: {
    sandboxOpId: v.string(), jobId: v.string(), attemptId: v.string(), epoch: v.number(),
    command: v.string(), handle: v.object({ sessionId: v.string(), commandId: v.string() }),
  },
  handler: async (ctx, args) => {
    const id = appId();
    const now = Date.now();
    await ctx.db.insert("sandboxCommands", {
      appId: id, sandboxOpId: args.sandboxOpId, jobId: args.jobId, attemptId: args.attemptId,
      epoch: args.epoch, command: args.command, status: "running", handle: args.handle,
      logTail: "", createdAtMs: now, updatedAtMs: now,
    });
    return { commandId: id };
  },
});

export const getCommand = internalQuery({
  args: { commandId: v.string(), attemptId: v.string(), epoch: v.number() },
  handler: async (ctx, args) => {
    const command = await ctx.db.query("sandboxCommands").withIndex("by_appId", (q) => q.eq("appId", args.commandId)).unique();
    if (!command || command.attemptId !== args.attemptId || command.epoch !== args.epoch) throw new ConvexError("sandbox_command_not_found");
    const op = await ctx.db.query("sandboxOps").withIndex("by_appId", (q) => q.eq("appId", command.sandboxOpId)).unique();
    if (!op?.sandbox) throw new ConvexError("sandbox_not_ready");
    return { command, sandbox: op.sandbox };
  },
});

export const updateCommand = internalMutation({
  args: {
    commandId: v.string(),
    status: v.union(v.literal("running"), v.literal("exited"), v.literal("failed"), v.literal("lost")),
    exitCode: v.optional(v.number()),
    logTail: v.string(),
  },
  handler: async (ctx, args) => {
    const command = await ctx.db.query("sandboxCommands").withIndex("by_appId", (q) => q.eq("appId", args.commandId)).unique();
    if (!command) return;
    await ctx.db.patch(command._id, {
      status: args.status,
      ...(args.exitCode === undefined ? {} : { exitCode: args.exitCode }),
      logTail: args.logTail.slice(-LOG_TAIL_MAX_BYTES),
      updatedAtMs: Date.now(),
    });
  },
});
