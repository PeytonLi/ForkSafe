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
  return { workspaceRoot, mcpServerName: "forksafe" as const, allowedMcpTools: ["read_findings", "submit_candidate", "run_experiment"] };
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
    expect(decidePermission({
      toolUses: [use(ToolConfirmationType.Execute, { command: "arbitrary" }, "ToolSearch")], options: opts,
    }, p).allowed).toBe(true);
    expect(decidePermission({
      toolUses: [use(ToolConfirmationType.Execute, { command: "arbitrary" }, "Script")], options: opts,
    }, p).allowed).toBe(false);
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

  it("validates each nested Script confirmation and rejects missing or nested Scripts", async () => {
    const p = await policy();
    const decide = (entry: PermissionToolUse) => decidePermission({ toolUses: [entry], options: opts }, p).allowed;
    const script = (calls: unknown) => use(ToolConfirmationType.Script, { calls });

    expect(decide(script([{
      toolName: "forksafe___read_findings",
      confirmation: { type: ToolConfirmationType.McpTool, toolName: "read_findings", serverName: "forksafe" },
    }]))).toBe(true);
    expect(decide(script([{
      toolName: "Execute",
      confirmation: { type: ToolConfirmationType.Execute, command: "rm -rf /" },
    }]))).toBe(false);
    expect(decide(script([{
      toolName: "Script",
      confirmation: { type: ToolConfirmationType.Script, calls: [] },
    }]))).toBe(false);
    expect(decide(script([{
      toolName: "ToolSearch",
      confirmation: { type: ToolConfirmationType.Script, calls: [] },
    }]))).toBe(false);
    expect(decide(script(undefined))).toBe(false);
    expect(decide(script([]))).toBe(true);
  });

  it("resolves namespaced MCP tools and requires a trusted server or ForkSafe prefix", async () => {
    const p = await policy();
    const decide = (details: Record<string, unknown>) =>
      decidePermission({ toolUses: [use(ToolConfirmationType.McpTool, details)], options: opts }, p).allowed;

    expect(decide({ serverName: "forksafe", toolName: "forksafe___submit_candidate" })).toBe(true);
    expect(decide({ toolName: "forksafe___run_experiment" })).toBe(true);
    expect(decide({ toolName: "run_experiment" })).toBe(false);
    expect(decide({ serverName: "evil", toolName: "forksafe___submit_candidate" })).toBe(false);
    expect(decide({ serverName: "evil", server: "forksafe", toolName: "submit_candidate" })).toBe(false);
    expect(decide({ serverName: "forksafe", toolName: "forksafe___delete_everything" })).toBe(false);

    for (const separator of ["___", "__", "_", ".", ":", "/"]) {
      expect(decide({ serverName: "forksafe", toolName: `forksafe${separator}run_experiment` })).toBe(true);
    }
  });
});
