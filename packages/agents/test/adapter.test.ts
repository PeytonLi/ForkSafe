import { describe, expect, it, vi } from "vitest";
import type { DroidSession } from "@factory/droid-sdk/node";
import { computeDisabledToolIds, LiveFactoryAdapter, ToolSurfaceError, type ToolInfoLike } from "../src/adapter.js";

function info(id: string, source: ToolInfoLike["source"], allowed: boolean, serverName?: string): ToolInfoLike {
  return { id, source, allowed, ...(serverName ? { serverName } : {}) };
}

describe("Factory tool surface", () => {
  it("disables all built-ins and foreign MCP tools while preserving ForkSafe MCP tools", () => {
    const tools = [
      info("Script", "native", true),
      info("ToolSearch", "native", true),
      info("NewThing", "native", true),
      info("mcp__forksafe__inspect_failure", "mcp", true, "forksafe"),
      info("mcp__forksafe__read_source", "mcp", true, "forksafe"),
      info("mcp__foreign__read", "mcp", true, "foreign"),
    ];
    expect(computeDisabledToolIds(tools)).toEqual([
      "Script", "ToolSearch", "NewThing", "mcp__foreign__read",
    ]);
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
    expect(session.updateSettings).toHaveBeenCalledOnce();
    expect(session.listTools).toHaveBeenCalledTimes(2);
    expect(session.close).toHaveBeenCalledOnce();
  });
});
