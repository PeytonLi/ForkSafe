import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createSandboxProvider, sandboxLabels } from "../src/index.js";
import type { SandboxHandle } from "../src/types.js";

const snapshots = JSON.parse(await readFile(resolve(process.cwd(), "../../infra/daytona/snapshots.json"), "utf8"));
const runId = randomUUID();
const provider = createSandboxProvider();
const createdAt = Date.now();
let ref: SandboxHandle["ref"] | undefined;

const smokeScript = `import json
import mujoco
model = mujoco.MjModel.from_xml_string('<mujoco><worldbody><geom name="ground" type="plane" size="2 2 0.1"/><body pos="0 0 1"><freejoint/><geom type="box" size="0.1 0.1 0.1" mass="1"/></body></worldbody></mujoco>')
data = mujoco.MjData(model)
for _ in range(500):
    mujoco.mj_step(model, data)
report = {"mujocoVersion": mujoco.__version__, "steps": 500, "finalZ": float(data.qpos[2]), "contacts": int(data.ncon)}
with open('/workspace/daytona-smoke.json', 'w', encoding='utf-8') as output:
    json.dump(report, output)
print(json.dumps(report))
`;

try {
  const sandbox = await provider.create({
    operationId: runId,
    purpose: "execution",
    labels: sandboxLabels({ operationId: runId, purpose: "execution", investigationId: runId }),
    snapshot: snapshots.execution.id ?? snapshots.execution.name,
    resources: { cpu: 2, memoryGiB: 4, diskGiB: 10 },
    autoStopMinutes: 15,
    autoDeleteMinutes: 60,
  });
  ref = sandbox.ref;
  const startupMs = Date.now() - createdAt;
  await provider.uploadFile(sandbox.ref, "/workspace/daytona-smoke.py", new TextEncoder().encode(smokeScript));
  const executionStartedAt = Date.now();
  const result = await provider.exec(sandbox.ref, {
    command: "python3 /workspace/daytona-smoke.py",
    cwd: "/workspace",
    timeoutSec: 60,
  });
  const executionMs = Date.now() - executionStartedAt;
  if (result.exitCode !== 0) throw new Error(`physics_smoke_failed:${result.exitCode}`);
  const output = new TextDecoder().decode(await provider.downloadFile(sandbox.ref, "/workspace/daytona-smoke.json").catch(() => new Uint8Array()));
  const report = output ? JSON.parse(output) : JSON.parse(result.output.trim().split("\n").at(-1) ?? "{}");
  if (report.steps !== 500 || !Number.isFinite(report.finalZ)) throw new Error("physics_smoke_result_invalid");
  const destroyStartedAt = Date.now();
  await provider.destroy(sandbox.ref);
  const destroyMs = Date.now() - destroyStartedAt;
  const remaining = await provider.get(sandbox.ref);
  if (remaining) throw new Error("sandbox_cleanup_not_confirmed");
  console.log(JSON.stringify({
    label: "Daytona physics smoke — not a ForkSafe experiment",
    runId,
    report,
    timingsMs: { startup: startupMs, execution: executionMs, destroy: destroyMs },
    destroyedAndConfirmed: true,
  }));
} catch (error) {
  if (ref) {
    try {
      await provider.destroy(ref);
      const remaining = await provider.get(ref);
      if (remaining) console.error("cleanup_warning: sandbox still exists after destroy attempt");
    } catch {
      console.error("cleanup_warning: sandbox termination is ambiguous");
    }
  }
  const message = error instanceof Error ? error.message : "unknown_error";
  console.error(`daytona_physics_smoke_failed: ${message}`);
  process.exitCode = 1;
}
