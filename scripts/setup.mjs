#!/usr/bin/env node
// Phase-1 setup: installs Python deps via uv and fetches pinned robot assets.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const run = (cmd, opts = {}) => { console.log("+", cmd); execSync(cmd, { cwd: root, stdio: "inherit", ...opts }); };
if (!existsSync(resolve(root, ".venv"))) run("uv venv --python 3.12 .venv");
run("uv sync --frozen || uv sync");
run("node scripts/fetch-assets.mjs");
console.log("setup done");
