// Publishes the runner bundle, the simulator bundle (services/simulator +
// evaluation manifests + controllers + robot assets + preflight) and the
// baseline controller to the hosted Convex deployment (/bundles/upload).
// Usage: CONVEX_SITE_URL=https://<deployment>.convex.site INTEGRATION_SHARED_SECRET=... node scripts/publish-bundles.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const siteUrl = process.env.CONVEX_SITE_URL;
const secret = process.env.INTEGRATION_SHARED_SECRET;
if (!siteUrl || !secret) throw new Error("CONVEX_SITE_URL and INTEGRATION_SHARED_SECRET are required");

async function upload(key, bytes, note) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const response = await fetch(`${siteUrl.replace(/\/$/, "")}/bundles/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/octet-stream", "x-forksafe-bundle": key, "x-forksafe-sha256": sha256, "x-forksafe-note": note },
    body: bytes,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${key} upload failed: HTTP ${response.status} ${body}`);
  console.log(`${key}: ${sha256} (${bytes.byteLength} bytes) ${body}`);
}

const runnerPath = resolve(here, "../dist/runner.mjs");
await stat(runnerPath).catch(() => { throw new Error("run `node scripts/build-bundle.mjs` first"); });
await upload("runner", await readFile(runnerPath), `git ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo }).toString().trim()}`);

const staging = await mkdtemp(join(tmpdir(), "forksafe-sim-"));
const copies = [
  ["services/simulator", "services/simulator"],
  ["evaluation", "evaluation"],
  ["controllers", "controllers"],
  ["assets/robots", "assets/robots"],
];
for (const [from, to] of copies) {
  execFileSync("mkdir", ["-p", dirname(join(staging, to))]);
  execFileSync("cp", ["-R", join(repo, from), join(staging, to)]);
}
execFileSync("cp", [join(here, "forksafe_preflight.py"), join(staging, "forksafe_preflight.py")]);
execFileSync("find", [staging, "-name", "__pycache__", "-prune", "-exec", "rm", "-rf", "{}", "+"]);
const tarPath = join(staging, "..", `forksafe-sim-${Date.now()}.tar`);
execFileSync("tar", ["-cf", tarPath, "-C", staging, "."]);
await upload("simulator", await readFile(tarPath), "services/simulator + evaluation + controllers + assets");
await upload("baseline_controller", await readFile(join(repo, "controllers/baseline/task_controller.py")), "controllers/baseline/task_controller.py");
