import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const candidates = [
  ...((process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "spacetime"))),
  join(homedir(), ".local", "bin", "spacetime"),
];
const spacetime = candidates.find((candidate) => existsSync(candidate));
if (!spacetime) {
  console.error("SpacetimeDB CLI not found; install CLI 2.13.0 or add it to PATH");
  process.exit(1);
}

if (existsSync("client/module_bindings/index.ts")) process.exit(0);

const result = spawnSync(
  spacetime,
  [
    "generate",
    "--lang",
    "typescript",
    "--out-dir",
    "client/module_bindings",
    "--module-path",
    ".",
    "-y",
  ],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
