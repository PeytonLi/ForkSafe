import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function environmentWorkspace(
  investigationId: string,
  environmentId: string,
  root = process.env.RUNNER_WORKSPACE_ROOT ?? "./var/workspaces",
): Promise<string> {
  if (!UUID.test(investigationId) || !UUID.test(environmentId)) throw new TypeError("Workspace IDs must be UUIDs");
  const absoluteRoot = resolve(root);
  const workspace = resolve(absoluteRoot, investigationId, environmentId);
  const path = relative(absoluteRoot, workspace);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new TypeError("Workspace escaped root");
  await mkdir(workspace, { recursive: true });
  return workspace;
}
