import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolConfirmationOutcome, ToolConfirmationType } from "@factory/droid-sdk/node";
import { ActivityLog } from "../src/activity-log.js";
import { FixtureFactoryAdapter, type AdapterSessionOptions, type FactoryAdapter } from "../src/adapter.js";
import { SessionCapError, SessionManager, SessionRegistrationError } from "../src/session-manager.js";
import { UsageLedger } from "../src/usage.js";

const investigations = [crypto.randomUUID(), crypto.randomUUID()];
const environments = Array.from({ length: 7 }, () => crypto.randomUUID());
const dirs: string[] = [];
const backend = {
  async inspect_failure() { return { status: "blocked" }; },
  async read_source() { return { status: "blocked" }; },
  async apply_patch() { return { status: "blocked" }; },
  async fork_candidate() { return { status: "blocked" }; },
  async request_subtask() { return { status: "blocked" }; },
  async run_experiment() { return { status: "blocked" }; },
  async propose_controller_revision() { return { status: "blocked" }; },
  async submit_candidate() { return { status: "blocked" }; },
  async read_findings() { return []; },
  async write_finding() { return { status: "local" }; },
  async request_evidence() { return { status: "local" }; },
};
async function manager(
  adapter = new FixtureFactoryAdapter(),
  opts: Pick<ConstructorParameters<typeof SessionManager>[0], "sessionsPerEnvironment" | "maxActiveTurns" | "onTurnComplete" | "onSessionReady"> = {},
) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forksafe-sessions-"));
  dirs.push(workspaceRoot);
  return new SessionManager({
    adapter, ledger: new UsageLedger(), workspaceRoot,
    toolBackend: backend, log: new ActivityLog(), ...opts,
  });
}
afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("SessionManager", () => {
  it("enforces environment session caps and the absolute limit", async () => {
    const defaultManager = await manager();
    await defaultManager.createSession({ investigationId: investigations[0]!, environmentId: environments[0]! });
    await defaultManager.createSession({ investigationId: investigations[0]!, environmentId: environments[0]! });
    await expect(defaultManager.createSession({ investigationId: investigations[0]!, environmentId: environments[0]! })).rejects.toBeInstanceOf(SessionCapError);
    const three = await manager(new FixtureFactoryAdapter(), { sessionsPerEnvironment: 3 });
    for (let i = 0; i < 3; i += 1) await three.createSession({ investigationId: investigations[0]!, environmentId: environments[1]! });
    expect(() => new SessionManager({ adapter: new FixtureFactoryAdapter(), ledger: new UsageLedger(), workspaceRoot: "/tmp", toolBackend: backend, log: new ActivityLog(), sessionsPerEnvironment: 4 })).toThrow(RangeError);
  });

  it("isolates workspace cwd by environment", async () => {
    const sessions = await manager();
    const first = await sessions.createSession({ investigationId: investigations[0]!, environmentId: environments[2]! });
    const second = await sessions.createSession({ investigationId: investigations[0]!, environmentId: environments[3]! });
    expect(sessions.toAgentSession(first.sessionId).environmentId).not.toBe(sessions.toAgentSession(second.sessionId).environmentId);
  });

  it("caps global active turns at four while allowing concurrent sessions", async () => {
    let active = 0;
    let maximum = 0;
    const adapter = new FixtureFactoryAdapter({ gate: async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    } });
    const sessions = await manager(adapter);
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await sessions.createSession({ investigationId: investigations[0]!, environmentId: environments[i]! })).sessionId);
    await Promise.all(ids.map((id) => sessions.runTurn(id, "inspect")));
    expect(maximum).toBe(4);
  });

  it("returns retry_later instead of waiting when all active turn slots are occupied", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const adapter = new FixtureFactoryAdapter({ gate: () => { markEntered(); return gate; } });
    const sessions = await manager(adapter, { maxActiveTurns: 1 });
    const investigationId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();
    const parent = await sessions.createSession({ investigationId, environmentId });
    const parentTurn = sessions.runTurn(parent.sessionId, "parent");
    await entered;

    const result = await sessions.runSubtask({ prompt: "analyze", purpose: "focused analysis" }, {
      investigationId, environmentId, sessionId: parent.sessionId,
      attemptId: crypto.randomUUID(), grantId: crypto.randomUUID(), epoch: 0,
      turnBudget: { used: 1, max: 4 },
    });
    expect(result).toEqual({ status: "retry_later", reason: "turn_cap" });
    release();
    await expect(parentTurn).resolves.toMatchObject({ success: true });
  });

  it("reports fixture and unknown usage, and replaces missing vendor sessions with lineage", async () => {
    const adapter = new FixtureFactoryAdapter({ usage: "unknown" });
    const sessions = await manager(adapter);
    const created = await sessions.createSession({ investigationId: investigations[0]!, environmentId: environments[5]! });
    const outcome = await sessions.runTurn(created.sessionId, "fixture");
    expect(outcome.mode).toBe("fixture");
    expect(outcome.vendorRef.provider).toBe("local");
    expect(outcome.toolCalls[0]?.name).toBe("read_findings");
    expect(sessions.toAgentSession(created.sessionId).tokenUsage.usageKnown).toBe(false);
    (adapter as unknown as { sessions: Set<string> }).sessions.clear();
    const replacement = await sessions.resume(created.sessionId);
    expect(sessions.replacesSessionId(replacement.sessionId)).toBe(created.sessionId);
  });

  it("logs permission details without nested tool inputs", async () => {
    const fixture = new FixtureFactoryAdapter();
    let permissionHandler: AdapterSessionOptions["permissionHandler"];
    const adapter: FactoryAdapter = {
      mode: "fixture",
      createSession: async (options) => {
        permissionHandler = options.permissionHandler;
        return fixture.createSession(options);
      },
      resumeSession: async (vendorId, options) => {
        permissionHandler = options.permissionHandler;
        return fixture.resumeSession(vendorId, options);
      },
    };
    const log = new ActivityLog();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "forksafe-sessions-"));
    dirs.push(workspaceRoot);
    const sessions = new SessionManager({
      adapter, ledger: new UsageLedger(), workspaceRoot, toolBackend: backend, log,
    });
    await sessions.createSession({ investigationId: investigations[0]!, environmentId: environments[6]! });

    await permissionHandler!({
      toolUses: [{
        confirmationType: ToolConfirmationType.Script,
        details: {
          type: ToolConfirmationType.Script,
          calls: [{
            toolName: "forksafe___submit_candidate",
            toolInput: { privateValue: "do-not-log" },
            confirmation: {
              type: ToolConfirmationType.McpTool,
              toolName: "forksafe___submit_candidate",
              actualToolName: "submit_candidate",
              serverName: "forksafe",
            },
          }],
        },
      }],
      options: [{ value: ToolConfirmationOutcome.ProceedOnce }, { value: ToolConfirmationOutcome.Cancel }],
    });

    const permission = log.list().find((entry) => entry.kind === "permission");
    expect(permission?.data?.details).toEqual([{
      type: "script",
      calls: [{ toolName: "forksafe___submit_candidate", type: "mcp_tool" }],
    }]);
    expect(JSON.stringify(permission)).not.toContain("do-not-log");
    expect(JSON.stringify(permission)).not.toContain("toolInput");
  });

  it("returns session_cap when a subtask would create the third environment session", async () => {
    const sessions = await manager();
    const investigationId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();
    const parent = await sessions.createSession({ investigationId, environmentId });
    await sessions.createSession({ investigationId, environmentId });
    await expect(sessions.runSubtask({ prompt: "analyze", purpose: "focused analysis" }, {
      investigationId, environmentId, sessionId: parent.sessionId,
      attemptId: crypto.randomUUID(), grantId: crypto.randomUUID(), epoch: 0,
      turnBudget: { used: 0, max: 4 },
    })).resolves.toEqual({ status: "rejected", reason: "session_cap" });
  });

  it("records subtask checkpoint roles and parent lineage", async () => {
    const checkpoints: any[] = [];
    const readySessions: any[] = [];
    const order: string[] = [];
    const sessions = await manager(new FixtureFactoryAdapter(), {
      onTurnComplete: async (checkpoint) => { checkpoints.push(checkpoint); order.push("checkpoint"); },
      onSessionReady: async ({ session }) => { readySessions.push(session); order.push("session"); return { ok: true }; },
    });
    const investigationId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();
    const parent = await sessions.createSession({ investigationId, environmentId });
    await sessions.runSubtask({ prompt: "analyze", purpose: "focused analysis" }, {
      investigationId, environmentId, sessionId: parent.sessionId,
      attemptId: crypto.randomUUID(), grantId: crypto.randomUUID(), epoch: 0, jobId: crypto.randomUUID(),
      turnBudget: { used: 0, max: 4 },
    });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ role: "subtask", parentSessionId: parent.sessionId, turnIndex: 0 });
    expect(readySessions).toHaveLength(1);
    expect(readySessions[0]).toMatchObject({ state: "created", mode: "fixture", factorySession: { provider: "local" } });
    expect(order).toEqual(["session", "checkpoint"]);
  });

  it("surfaces rejected subtask session registration to the parent lease", async () => {
    const sessions = await manager(new FixtureFactoryAdapter(), {
      onSessionReady: async () => { throw new Error("HTTP 409"); },
    });
    const investigationId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();
    const parent = await sessions.createSession({ investigationId, environmentId });
    const result = await sessions.runSubtask({ prompt: "analyze", purpose: "focused analysis" }, {
      investigationId, environmentId, sessionId: parent.sessionId,
      attemptId: crypto.randomUUID(), grantId: crypto.randomUUID(), epoch: 0,
      turnBudget: { used: 0, max: 4 },
    });
    expect(result).toEqual({ status: "rejected", reason: "session_registration_failed" });
    expect(sessions.takeSessionRegistrationError(parent.sessionId)).toBeInstanceOf(SessionRegistrationError);
  });
});
