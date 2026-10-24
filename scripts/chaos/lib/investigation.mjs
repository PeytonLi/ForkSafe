import { envGet, inlineQuery, runFn } from "./convex.mjs";

export async function capture({ title, envs, runId, scenario }) {
  return await runFn("investigations:capture", {
    title: title || `chaos: ${scenario} ${runId}`,
    seed: 1,
    sceneOverrides: {},
    requestedEnvironments: envs,
    autoStart: true,
    idempotencyKey: `chaos:${runId}:${scenario}`,
    serviceToken: await envGet("INTEGRATION_SHARED_SECRET"),
  });
}

export async function snapshot(investigationId) {
  const id = JSON.stringify(investigationId);
  return await inlineQuery(`const investigationId = ${id};
    const investigation = await ctx.db.query("investigations").withIndex("by_appId", q => q.eq("appId", investigationId)).unique();
    const environments = await ctx.db.query("environments").withIndex("by_investigation", q => q.eq("investigationId", investigationId)).collect();
    const jobs = await ctx.db.query("jobs").withIndex("by_investigation", q => q.eq("investigationId", investigationId)).collect();
    const attempts = (await Promise.all(jobs.map(job => ctx.db.query("attempts").withIndex("by_job", q => q.eq("jobId", job.appId)).collect()))).flat();
    const grants = (await Promise.all(attempts.map(attempt => ctx.db.query("grants").withIndex("by_attempt", q => q.eq("attemptId", attempt.appId)).collect()))).flat();
    const sandboxOps = await ctx.db.query("sandboxOps").withIndex("by_investigation", q => q.eq("investigationId", investigationId)).collect();
    const sessions = await ctx.db.query("sessions").withIndex("by_investigation", q => q.eq("investigationId", investigationId)).collect();
    const candidates = await ctx.db.query("candidates").withIndex("by_investigation", q => q.eq("investigationId", investigationId)).collect();
    const experiments = (await ctx.db.query("experiments").withIndex("by_investigation", q => q.eq("investigationId", investigationId)).collect())
      .map(({ appId, environmentId, startedAtMs, purpose, status }) => ({ appId, environmentId, startedAtMs, purpose, status }));
    const handoffs = (await Promise.all(jobs.map(job => ctx.db.query("handoffs").withIndex("by_operation", q => q.eq("operationId", job.operationId)).collect()))).flat();
    const runnerCredentials = (await ctx.db.query("runnerCredentials").withIndex("by_investigation", q => q.eq("investigationId", investigationId)).collect())
      .map(({ secret, ...credential }) => credential);
    const activeSandboxReservations = await ctx.db.query("reservations").withIndex("by_kind_status", q => q.eq("kind", "sandbox").eq("status", "active")).collect();
    const retainedSandboxReservations = await ctx.db.query("reservations").withIndex("by_kind_status", q => q.eq("kind", "sandbox").eq("status", "retained_ambiguous")).collect();
    const activeModelTurnReservations = await ctx.db.query("reservations").withIndex("by_kind_status", q => q.eq("kind", "model_turn").eq("status", "active")).collect();
    return {
      investigation, environments, jobs, attempts, grants, sandboxOps, sessions, candidates, experiments, handoffs, runnerCredentials,
    global: {
      activeSandboxReservations: activeSandboxReservations.length,
      retainedAmbiguousSandboxReservations: retainedSandboxReservations.length,
      activeSandboxReservationCount: activeSandboxReservations.length + retainedSandboxReservations.length,
      activeModelTurnReservations: activeModelTurnReservations.length,
    },
  };
  `);
}

export async function globalSnapshot() {
  return await inlineQuery(`
    const activeSandbox = await ctx.db.query("reservations").withIndex("by_kind_status", q => q.eq("kind", "sandbox").eq("status", "active")).collect();
    const retainedSandbox = await ctx.db.query("reservations").withIndex("by_kind_status", q => q.eq("kind", "sandbox").eq("status", "retained_ambiguous")).collect();
    const activeModelTurns = await ctx.db.query("reservations").withIndex("by_kind_status", q => q.eq("kind", "model_turn").eq("status", "active")).collect();
    return {
      activeSandboxReservations: activeSandbox.length,
      retainedAmbiguousSandboxReservations: retainedSandbox.length,
      activeSandboxReservationCount: activeSandbox.length + retainedSandbox.length,
      activeModelTurnReservations: activeModelTurns.length,
    };`);
}

export async function credentialFor(environmentId) {
  return await inlineQuery(`
    const now = Date.now();
    const rows = await ctx.db.query("runnerCredentials").withIndex("by_environment", q => q.eq("environmentId", ${JSON.stringify(environmentId)})).collect();
    const row = rows.filter(item => item.revokedAtMs === undefined && item.expiresAtMs > now).sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    return row ? { credentialId: row.appId, secret: row.secret, expiresAtMs: row.expiresAtMs, investigationId: row.investigationId } : null;`);
}

export async function cancel(investigationId) {
  return await runFn("investigations:cancel", {
    investigationId,
    serviceToken: await envGet("INTEGRATION_SHARED_SECRET"),
  });
}

export async function waitFor(fn, { timeoutMs, intervalMs = 1_000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() <= deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return lastValue ?? null;
}
