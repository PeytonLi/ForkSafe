import { resolve, relative, isAbsolute, sep } from "node:path";
import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
} from "@factory/droid-sdk/node";

export type PermissionPolicy = {
  workspaceRoot: string;
  mcpServerName: "forksafe";
  allowedMcpTools: string[];
};

export type PermissionToolUse = {
  confirmationType: string;
  details: Record<string, unknown> & { type?: string };
  name?: string;
};
export type PermissionParams = {
  toolUses: PermissionToolUse[];
  options: { value: ToolConfirmationOutcome }[];
};

const SAFE_COMMANDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "pwd", "stat", "file", "diff", "git"]);
const FACTORY_META_TOOL_NAMES = new Set(["Script", "ToolSearch"]);
const META = /[;&|><`\n\r$~()]/;

function withinWorkspace(root: string, filePath: string): boolean {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, filePath);
  const rel = relative(absoluteRoot, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function insideWorkspace(root: string, filePath: string): boolean {
  return resolve(root) !== resolve(root, filePath) && withinWorkspace(root, filePath);
}

function safeCommand(command: string, workspaceRoot: string): boolean {
  if (!command || META.test(command)) return false;
  const tokens = command.trim().split(/\s+/);
  const first = tokens[0];
  if (!first || !SAFE_COMMANDS.has(first)) return false;
  if (first === "git" && !["status", "diff", "log", "show"].includes(tokens[1] ?? "")) return false;
  if (first === "find" && tokens.some((token) => ["-exec", "-execdir", "-delete", "-ok"].includes(token))) return false;
  if ((first === "grep" || first === "rg") && tokens.some((token) => token === "-f" || token === "--file" || token.startsWith("--file="))) return false;
  let patternSkipped = false;
  for (const argument of tokens.slice(1)) {
    if (argument.startsWith("-")) continue;
    if ((first === "grep" || first === "rg") && !patternSkipped) {
      patternSkipped = true;
      continue;
    }
    if ((argument.includes("/") || argument === ".." || argument.startsWith(".")) && !withinWorkspace(workspaceRoot, argument)) {
      return false;
    }
  }
  return true;
}

function allowedUse(use: PermissionToolUse, policy: PermissionPolicy): boolean {
  const type = use.confirmationType;
  const details = use.details;
  if (FACTORY_META_TOOL_NAMES.has(use.name ?? "") || FACTORY_META_TOOL_NAMES.has(String(details.toolName ?? ""))) return true;
  if (type === ToolConfirmationType.Create || details.type === ToolConfirmationType.Create) {
    return typeof details.filePath === "string" && insideWorkspace(policy.workspaceRoot, details.filePath);
  }
  if (type === ToolConfirmationType.Execute || details.type === ToolConfirmationType.Execute) {
    const command = typeof details.command === "string" ? details.command : "";
    if (!safeCommand(command, policy.workspaceRoot)) return false;
    const extracted = details.extractedCommands;
    return !Array.isArray(extracted) || extracted.every((item) => typeof item === "string" && safeCommand(item, policy.workspaceRoot));
  }
  if (type === ToolConfirmationType.McpTool || details.type === ToolConfirmationType.McpTool) {
    const server = details.serverName ?? details.server;
    const toolName = details.toolName ?? use.name;
    return server === policy.mcpServerName && typeof toolName === "string" && policy.allowedMcpTools.includes(toolName);
  }
  return false;
}

export function decidePermission(
  params: PermissionParams,
  policy: PermissionPolicy,
): { outcome: ToolConfirmationOutcome; allowed: boolean; reasons: string[] } {
  const reasons = params.toolUses.length === 0
    ? ["empty tool request"]
    : params.toolUses.flatMap((use) => allowedUse(use, policy) ? [] : [`denied ${use.name ?? use.confirmationType}`]);
  const desired = reasons.length === 0 ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel;
  const offered = params.options.some((option) => option.value === desired);
  if (!offered) return { outcome: ToolConfirmationOutcome.Cancel, allowed: false, reasons: [...reasons, `${desired} was not offered`] };
  return { outcome: desired, allowed: desired === ToolConfirmationOutcome.ProceedOnce, reasons };
}

export function createPermissionHandler(policy: PermissionPolicy) {
  return (params: PermissionParams): ToolConfirmationOutcome => decidePermission(params, policy).outcome;
}
