#!/usr/bin/env node
// ForkSafe doctor: reports tool availability and missing credential NAMES only.
// Never prints secret values.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envFile = process.env.ENV_FILE ?? ".env.local";

function loadEnv() {
  const env = { ...process.env };
  for (const name of [".env.local", ".env"]) {
    const p = resolve(root, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        if (!(m[1] in env) || env[m[1]] === "") env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
      }
    }
  }
  return env;
}

const env = loadEnv();
const blank = (v) => v === undefined || v === "";

const REQUIRED = {
  CONVEX_MODE: {
    cloud: ["CONVEX_URL", "CONVEX_ADMIN_KEY", "VITE_CONVEX_URL"],
    local: ["CONVEX_URL", "VITE_CONVEX_URL"],
  },
  DAYTONA_MODE: { cloud: ["DAYTONA_API_KEY"] },
  FACTORY_MODE: { cloud: ["FACTORY_API_KEY"] },
  ELASTIC_MODE: { cloud: ["ELASTICSEARCH_URL", "ELASTICSEARCH_API_KEY"], local: ["ELASTICSEARCH_URL"] },
  ELASTIC_AGENT_BUILDER_MODE: { cloud: ["KIBANA_URL", "KIBANA_API_KEY"] },
  ATLASSIAN_MODE: {
    cloud: ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "ATLASSIAN_PROJECT_KEY"],
  },
};

const TOOLS = [
  ["node", "node --version"],
  ["pnpm", "pnpm --version"],
  ["python3", "python3 --version"],
  ["uv", "uv --version"],
  ["docker", "docker --version"],
  ["spacetime", `${process.env.HOME}/.local/bin/spacetime --version`],
  ["droid", `${process.env.HOME}/.local/bin/droid --version`],
];

let problems = 0;
console.log(`ForkSafe doctor (env file: ${envFile})\n`);
console.log("Tools:");
for (const [name, cmd] of TOOLS) {
  try {
    const v = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0];
    console.log(`  ok    ${name}  ${v.slice(0, 80)}`);
  } catch {
    console.log(`  MISS  ${name}`);
    problems++;
  }
}

console.log("\nIntegration modes:");
for (const [modeVar, perMode] of Object.entries(REQUIRED)) {
  const active = env[modeVar] ?? "cloud";
  if (active === "disabled") {
    console.log(`  ${modeVar}=disabled  -> not_implemented`);
    continue;
  }
  const missing = (perMode[active] ?? []).filter((n) => blank(env[n]));
  const status = active === "fixture" ? "fixture" : active === "local" ? "local" : missing.length ? "blocked" : "live";
  console.log(`  ${modeVar}=${active}  -> ${status}${missing.length ? `  missing: ${missing.join(", ")}` : ""}`);
  if (status === "blocked") problems++;
}

const mujoco = existsSync(resolve(root, "assets/robots/manifest.json"));
console.log(`\nRobot assets: ${mujoco ? "manifest present" : "MISSING (run pnpm setup)"}`);

console.log(`\n${problems === 0 ? "All required integrations ready." : `${problems} problem(s) — names above only; values are never printed.`}`);
process.exit(0);
