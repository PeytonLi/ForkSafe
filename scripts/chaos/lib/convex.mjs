import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const convexDir = fileURLToPath(new URL("../../../convex/", import.meta.url));
const secrets = new Set();

export function rememberSecret(value) {
  if (typeof value === "string" && value.length >= 4) secrets.add(value);
}

export function redactSecrets(value) {
  let text = String(value ?? "");
  for (const name of ["CONVEX_DEPLOY_KEY", "DAYTONA_API_KEY", "FACTORY_API_KEY", "INTEGRATION_SHARED_SECRET", "RUNNER_CALLBACK_SECRET"]) {
    const secret = process.env[name];
    if (secret) secrets.add(secret);
  }
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/((?:CONVEX_DEPLOY_KEY|DAYTONA_API_KEY|FACTORY_API_KEY|INTEGRATION_SHARED_SECRET|RUNNER_CALLBACK_SECRET)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

function parseJson(output, stderr = "") {
  const text = output.trim();
  if (!text) {
    const diagnostic = stderr.trim();
    if (!diagnostic) return null;
    throw new Error(`Convex CLI returned no JSON: ${redactSecrets(diagnostic.slice(0, 500))}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const firstObject = text.indexOf("{");
    const firstArray = text.indexOf("[");
    const starts = [firstObject, firstArray].filter((index) => index >= 0);
    if (!starts.length) throw new Error(`Convex CLI returned non-JSON output: ${redactSecrets(text.slice(0, 500))}`);
    const start = Math.min(...starts);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (end < start) throw new Error(`Convex CLI returned non-JSON output: ${redactSecrets(text.slice(0, 500))}`);
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error(`Convex CLI returned invalid JSON: ${redactSecrets(text.slice(0, 500))}`);
    }
  }
}

async function convex(args, { json = true } = {}) {
  try {
    const result = await execFileAsync("npx", ["convex", ...args], {
      cwd: convexDir,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return json ? parseJson(result.stdout, result.stderr) : result.stdout.trim();
  } catch (error) {
    const details = [error?.code, error?.stderr, error?.stdout, error?.message].filter(Boolean).join("\n");
    throw new Error(`Convex CLI failed: ${redactSecrets(details || "unknown error")}`);
  }
}

export async function inlineQuery(js) {
  return await convex(["run", "--inline-query", js]);
}

export async function runFn(name, args = {}) {
  return await convex(["run", name, JSON.stringify(args)]);
}

export async function envGet(name) {
  const value = await convex(["env", "get", name], { json: false });
  rememberSecret(value);
  return value;
}
