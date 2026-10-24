import { daytonaClient, isForksafeSandbox } from "../../lib/sandboxes.mjs";

let clientPromise;

async function client() {
  clientPromise ??= daytonaClient(process.env);
  return await clientPromise;
}

export async function listForksafe() {
  const api = await client();
  const sandboxes = [];
  for await (const sandbox of api.list({ labels: { "forksafe.project": "forksafe" } })) {
    if (isForksafeSandbox(sandbox)) {
      sandboxes.push({
        id: sandbox.id,
        name: sandbox.name,
        state: String(sandbox.state),
        labels: sandbox.labels,
      });
    }
  }
  return sandboxes;
}

export async function byInvestigation(investigationId) {
  return (await listForksafe()).filter((sandbox) => sandbox.labels?.["forksafe.investigation"] === investigationId);
}

export async function isGone(sandboxId) {
  try {
    const sandbox = await (await client()).get(sandboxId);
    const state = String(sandbox.state ?? "").toLowerCase();
    return state === "destroyed" || state === "deleted";
  } catch (error) {
    const status = error?.status ?? error?.statusCode ?? error?.response?.status;
    if (status === 404) return true;
    throw error;
  }
}
