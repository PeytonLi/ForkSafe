#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn("pnpm", [
  "--filter",
  "@forksafe/integrations",
  "daytona:prepare",
  ...process.argv.slice(2),
], { stdio: "inherit", shell: false });

child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
