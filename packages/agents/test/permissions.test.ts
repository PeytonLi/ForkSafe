import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolConfirmationOutcome, ToolConfirmationType } from "@factory/droid-sdk/node";
import { createPermissionHandler, decidePermission, type PermissionToolUse } from "../src/permissions.js";

const roots: string[] = [];
async function policy() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forksafe-permissions-"));
  roots.push(workspaceRoot);
  return { workspaceRoot, mcpServerName: "forksafe" as const, allowedMcpTools: ["read_findings"] };
}
const opts = Object.values(ToolConfirmationOutcome).map((value) => ({ value }));
function use(type: string, details: Record<string, unknown>, name?: string): PermissionToolUse {
  return { confirmationType: type, details: { type, ...details }, name };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("permission policy", () => {
  it("allows only workspace creates and denies escapes, edits, and patches", async () => {
    const p = await policy();
    const decide = (entry: PermissionToolUse) => decidePermission({ toolUses: [entry], options: opts }, p);
    expect(decide(use(ToolConfirmationType.Create, { filePath: "src/controller.py" })).allowed).toBe(true);
    for (const path of ["../outside", "/tmp/outside", p.workspaceRoot]) {
      expect(decide(use(ToolConfirmationType.Create, { filePath: path })).allowed).toBe(false);
    }
    expect(decide(use(ToolConfirmationType.Edit, { filePath: "src/a" })).allowed).toBe(false);
    expect(decide(use(ToolConfirmationType.ApplyPatch, {})).allowed).toBe(false);
  });

  it("allows narrow read-only commands and denies shell mutation or chaining", async () => {
    const p = await policy();
    const decide = (command: string) => decidePermission({
      toolUses: [use(ToolConfirmationType.Execute, { command })], options: opts,
    }, p).allowed;
    for (const command of ["ls -la", "git diff", "grep -n foo src"]) expect(decide(command)).toBe(true);
    for (const command of [
      "rm -rf x",
      "cat a > b",
      "ls | sh",
      "echo $(id)",
      "find . -delete",
      "git push",
      "cat /proc/self/environ",
      "cat ../other/x",
      "ls ~",
      "grep -r token /etc",
      "cat $HOME/x",
    ]) {
      expect(decide(command)).toBe(false);
    }
    for (const name of ["Script", "ToolSearch"]) {
      expect(decidePermission({
        toolUses: [use(ToolConfirmationType.Execute, { command: "arbitrary" }, name)], options: opts,
      }, p).allowed).toBe(true);
    }
    expect(decidePermission({
      toolUses: [use(ToolConfirmationType.Execute, { command: "rm x" }, "Execute")], options: opts,
    }, p).allowed).toBe(false);
    expect(decide("cat src/controller.py")).toBe(true);
    expect(decide("grep -n foo ./src")).toBe(true);
  });

  it("denies mixed batches and only permits allowlisted forksafe MCP calls", async () => {
    const p = await policy();
    const decide = (toolUses: PermissionToolUse[], options = opts) => decidePermission({ toolUses, options }, p);
    expect(decide([
      use(ToolConfirmationType.Create, { filePath: "ok.txt" }),
      use(ToolConfirmationType.Execute, { command: "rm x" }),
    ]).allowed).toBe(false);
    expect(decide([use(ToolConfirmationType.McpTool, { serverName: "forksafe", toolName: "read_findings" })]).allowed).toBe(true);
    expect(decide([use(ToolConfirmationType.McpTool, { serverName: "other", toolName: "read_findings" })]).allowed).toBe(false);
    expect(createPermissionHandler(p)({ toolUses: [use(ToolConfirmationType.Create, { filePath: "ok" })], options: [{ value: ToolConfirmationOutcome.Cancel }] })).toBe(ToolConfirmationOutcome.Cancel);
  });
});
