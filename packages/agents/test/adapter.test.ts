import { describe, expect, it, vi } from "vitest";
import type { DroidSession } from "@factory/droid-sdk/node";
import { computeDisabledToolIds, LiveFactoryAdapter, ToolSurfaceError, type ToolInfoLike } from "../src/adapter.js";

function info(id: string, source: ToolInfoLike["source"], allowed: boolean, serverName?: string): ToolInfoLike {
  return { id, source, allowed, ...(serverName ? { serverName } : {}) };
}

const liveMcpToolFixture: ToolInfoLike = {
  displayName: "inspect_failure", description: "Inspect the failure",
  category: "read", defaultAllowed: true, id: "forksafe___inspect_failure", allowed: true,
};

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

  it("fails closed when Script remains enabled after applying tool restrictions", async () => {
    const script = info("Script", "native", true);
    const session = {
      id: "vendor-session",
      listTools: vi.fn(async () => [script]),
      updateSettings: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    };
    const createSession = vi.fn(async () => session as unknown as DroidSession);
    const adapter = new LiveFactoryAdapter({}, {
      createSession: createSession as never,
      resumeSession: vi.fn() as never,
    });

    await expect(adapter.createSession({ cwd: "/workspace" })).rejects.toBeInstanceOf(ToolSurfaceError);
    expect(session.updateSettings).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(session.listTools).toHaveBeenCalledTimes(2);
    expect(session.close).toHaveBeenCalledTimes(2);
  });
});
