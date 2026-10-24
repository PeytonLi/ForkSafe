import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checks } from "./lib/check.mjs";
import { cleanupScenario } from "./lib/cleanup.mjs";
import { redactSecrets } from "./lib/convex.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scenarioNames = [
  "scale10",
  "runner-kill",
  "cancel-mid-run",
  "spacetime-blip",
  "duplicate-delivery",
  "cleanup",
];
const allScenarioNames = scenarioNames.filter((name) => name !== "cleanup");
const scenarioModules = {
  "scale10": () => import("./scenarios/scale10.mjs"),
  "runner-kill": () => import("./scenarios/runner-kill.mjs"),
  "cancel-mid-run": () => import("./scenarios/cancel-mid-run.mjs"),
  "spacetime-blip": () => import("./scenarios/spacetime-blip.mjs"),
  "duplicate-delivery": () => import("./scenarios/duplicate-delivery.mjs"),
  "cleanup": () => import("./scenarios/cleanup.mjs"),
};

export function parseArgs(argv) {
  const scenario = argv[0];
  if (!scenario || (![...scenarioNames, "all"].includes(scenario))) {
    throw new Error(`Unknown scenario. Choose one of: ${[...scenarioNames, "all"].join(", ")}`);
  }
  const options = { envs: 10, tokenCap: 20_000, timeoutMin: 15 };
  const flags = new Map([
    ["--envs", "envs"],
    ["--token-cap", "tokenCap"],
    ["--timeout-min", "timeoutMin"],
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = flags.get(flag);
    if (!key) throw new Error(`Unknown option: ${flag}`);
    const rawValue = argv[index + 1];
    if (rawValue === undefined || rawValue.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    const value = Number(rawValue);
    if (!Number.isInteger(value)) throw new Error(`${flag} must be an integer`);
    options[key] = value;
    index += 1;
  }
  if (options.envs < 1 || options.envs > 10) throw new Error("--envs must be between 1 and 10");
  if (options.tokenCap < 1 || options.tokenCap > 1_000_000) throw new Error("--token-cap must be between 1 and 1000000");
  if (options.timeoutMin < 1 || options.timeoutMin > 120) throw new Error("--timeout-min must be between 1 and 120");
  return { scenario, options };
}

function summarizeIds(ids) {
  return Object.entries(ids ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

async function executeScenario(name, runId, options) {
  const workdir = resolve(repoRoot, "var", "chaos", runId);
  mkdirSync(workdir, { recursive: true });
  const startedAtMs = Date.now();
  const collector = checks();
  const ctx = {
    scenario: name,
    runId,
    options,
    workdir,
    siteUrl: "https://giant-jellyfish-684.convex.site",
    checks: collector,
    ids: {},
    runners: [],
    evidence: {},
    tokens: 0,
  };
  let thrown;
  try {
    const module = await scenarioModules[name]();
    await module.run(ctx);
  } catch (error) {
    thrown = redactSecrets(error?.stack ?? error?.message ?? error);
    collector.check("ERROR", "scenario completes without an uncaught harness error", false, { error: thrown });
  } finally {
    try {
      await cleanupScenario(ctx);
    } catch (error) {
      collector.check("CLEANUP", "scenario cleanup completes", false, {
        error: redactSecrets(error?.stack ?? error?.message ?? error),
      });
    }
  }
  const finishedAtMs = Date.now();
  const passed = collector.results.length > 0 && collector.results.every((result) => result.passed);
  const report = {
    scenario: name,
    runId,
    startedAtMs,
    finishedAtMs,
    wallTimeMs: finishedAtMs - startedAtMs,
    passed,
    tokens: ctx.tokens,
    ids: ctx.ids,
    preflight: ctx.preflight ?? null,
    captureResponse: ctx.captureResponse ?? null,
    checks: collector.results,
    cleanup: ctx.cleanupResults ?? [],
    evidence: ctx.evidence,
    error: thrown ?? null,
  };
  const outputPath = resolve(workdir, `${name}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${redactSecrets(JSON.stringify(report, null, 2))}\n`, { mode: 0o600 });
  return { ...report, outputPath };
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(redactSecrets(error?.message ?? error));
    console.error(`Usage: pnpm chaos <${[...scenarioNames, "all"].join("|")}> [--envs N] [--token-cap N] [--timeout-min N]`);
    return 2;
  }
  const runId = `chaos-${Math.floor(Date.now() / 1_000)}`;
  const selected = parsed.scenario === "all"
    ? allScenarioNames
    : [parsed.scenario];
  const results = [];
  for (const name of selected) results.push(await executeScenario(name, runId, parsed.options));
  const table = results.map((result) => ({
    scenario: result.scenario,
    "pass/fail": result.passed ? "pass" : "fail",
    "key ids": summarizeIds(result.ids),
    "wall time": `${(result.wallTimeMs / 1_000).toFixed(1)}s`,
    tokens: result.tokens,
  }));
  console.table(table);
  for (const result of results) {
    console.log(`${result.scenario} results: ${result.outputPath}`);
    for (const check of result.checks) {
      console.log(`  ${check.id} ${check.status}: ${check.description}`);
    }
    if (result.error) console.error(`${result.scenario} error: ${result.error}`);
  }
  return results.every((result) => result.passed) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
