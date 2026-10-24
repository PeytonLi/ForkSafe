export type SandboxPurpose = "runner" | "execution" | "evaluator" | "bridge";

const allowedCommands: Record<SandboxPurpose, ReadonlySet<string>> = {
  execution: new Set(["python", "python3", "uv"]),
  evaluator: new Set(["python", "python3", "uv"]),
  runner: new Set(["node", "pnpm", "droid"]),
  bridge: new Set(["node"]),
};

const shellCharacters = /[;&|`$<>(){}'"\\\n\r]/;

export function validateCommand(
  purpose: SandboxPurpose,
  command: string,
  cwd?: string,
): { ok: true; argv: string[] } | { ok: false; reason: string } {
  if (shellCharacters.test(command)) return { ok: false, reason: "shell_metacharacter" };
  if (cwd && (/[;&|`$<>(){}'"\\\n\r]/.test(cwd) || cwd.split("/").includes(".."))) {
    return { ok: false, reason: "cwd_not_allowed" };
  }
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return { ok: false, reason: "empty_command" };
  if (!allowedCommands[purpose].has(argv[0]!)) return { ok: false, reason: "command_not_allowed" };
  if (cwd?.startsWith("/") && !["/workspace", "/home/daytona"].some((root) =>
    cwd === root || cwd.startsWith(`${root}/`),
  )) return { ok: false, reason: "cwd_not_allowed" };
  return { ok: true, argv };
}
