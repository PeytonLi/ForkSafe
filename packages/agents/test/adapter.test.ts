import { describe, expect, it, vi } from "vitest";
import type { DroidSession } from "@factory/droid-sdk/node";
import {
  computeDisabledToolIds,
  DISABLED_BUILTIN_TOOL_IDS,
  LiveFactoryAdapter,
  ToolSurfaceError,
  type ToolInfoLike,
} from "../src/adapter.js";
import { FORKSAFE_TOOL_NAMES } from "../src/tools.js";

function info(id: string, source: ToolInfoLike["source"], allowed: boolean, serverName?: string): ToolInfoLike {
  return { id, source, allowed, ...(serverName ? { serverName } : {}) };
}

function liveBuiltinTool(id: string, category: string): ToolInfoLike {
  return { displayName: id, description: `Factory ${category} tool`, category, defaultAllowed: true, id, allowed: true };
}

const liveMcpToolFixture: ToolInfoLike = {
  displayName: "inspect_failure", description: "Inspect the failure",
  category: "read", defaultAllowed: true, id: "forksafe___inspect_failure", allowed: true,
};
const liveForksafeTools: ToolInfoLike[] = FORKSAFE_TOOL_NAMES.map((name) => ({
  displayName: name, description: `ForkSafe ${name}`, category: "read", defaultAllowed: true,
  id: `forksafe___${name}`, allowed: true,
}));

function mockSession(tools: ToolInfoLike[]) {
  const session = {
    id: "vendor-session",
    listTools: vi.fn(async () => tools as never),
    close: vi.fn(async () => undefined),
  };
  return { session: session as unknown as DroidSession, close: session.close };
}

describe("Factory tool surface", () => {
  it("disables all built-ins and foreign MCP tools while preserving ForkSafe MCP tools", () => {
    const tools = [
      info("Script", "native", true),
      info("ToolSearch", "native", true),
      info("NewThing", "native", true),
      { ...liveMcpToolFixture, id: "forksafe___inspect_failure" },
      { ...liveMcpToolFixture, id: "forksafe___read_source" },
      { ...liveMcpToolFixture, id: "foreign___read" },
    ];
    expect(computeDisabledToolIds(tools)).toEqual([
      "Script", "ToolSearch", "NewThing", "foreign___read",
    ]);
  });

  it("identifies ForkSafe tools from the live SDK tool ID shape", () => {
    expect(computeDisabledToolIds([
      { id: "Script", allowed: true, category: "builtin" },
      liveMcpToolFixture,
      { id: "other___read", allowed: true, category: "mcp" },
    ])).toEqual(["Script", "other___read"]);
  });

  it.each(["Script", "Execute"])("fails closed when %s remains enabled after recreation", async (toolId) => {
    const initial = mockSession([...liveForksafeTools, liveBuiltinTool(toolId, "execute")]);
    const recreated = mockSession([...liveForksafeTools, liveBuiltinTool(toolId, "execute")]);
    const createSession = vi.fn()
      .mockResolvedValueOnce(initial.session)
      .mockResolvedValueOnce(recreated.session);
    const adapter = new LiveFactoryAdapter({}, {
      createSession: createSession as never,
      resumeSession: vi.fn() as never,
    });

    await expect(adapter.createSession({ cwd: "/workspace" })).rejects.toBeInstanceOf(ToolSurfaceError);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(initial.close).toHaveBeenCalledOnce();
    expect(recreated.close).toHaveBeenCalledOnce();
  });

  it("recreates with every observed non-ForkSafe tool disabled and reports allowed ToolSearch", async () => {
    const observedBuiltins = [
      liveBuiltinTool("Execute", "execute"),
      liveBuiltinTool("Glob", "read"),
      liveBuiltinTool("Grep", "read"),
      liveBuiltinTool("LS", "read"),
      liveBuiltinTool("Read", "read"),
      liveBuiltinTool("Script", "execute"),
    ];
    const initial = mockSession([...observedBuiltins, ...liveForksafeTools]);
    const recreated = mockSession([...liveForksafeTools, liveBuiltinTool("ToolSearch", "execute")]);
    const createSession = vi.fn()
      .mockResolvedValueOnce(initial.session)
      .mockResolvedValueOnce(recreated.session);
    const adapter = new LiveFactoryAdapter({}, {
      createSession: createSession as never,
      resumeSession: vi.fn() as never,
    });

    const session = await adapter.createSession({ cwd: "/workspace" });

    expect(createSession).toHaveBeenCalledTimes(2);
    const recreateOptions = createSession.mock.calls[1]?.[0] as {
      disabledToolIds: string[];
      restrictToolIds: string[];
    };
    expect(recreateOptions.disabledToolIds).toEqual(expect.arrayContaining([
      ...DISABLED_BUILTIN_TOOL_IDS,
      ...observedBuiltins.map((tool) => tool.id),
    ]));
    expect(recreateOptions.restrictToolIds).toEqual(liveForksafeTools.map((tool) => tool.id));
    expect(session.enabledToolIds).toEqual([...liveForksafeTools.map((tool) => tool.id), "ToolSearch"]);
  });
});
