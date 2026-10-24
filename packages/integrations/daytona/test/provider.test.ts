import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Daytona } from "@daytonaio/sdk";
import { CloudDaytonaProvider } from "../src/cloud.js";
import { loadDaytonaConfig, type DaytonaConfig } from "../src/config.js";
import { LocalDockerProvider } from "../src/local.js";
import { CapacityError, type SandboxSpec } from "../src/types.js";

function sandbox(id: string, labels: Record<string, string>) {
  return { id, state: "started", labels };
}

function config(overrides: Partial<DaytonaConfig> = {}): DaytonaConfig {
  return {
    mode: "cloud",
    apiKey: "test-key-do-not-use",
    apiUrl: "https://api.daytona.invalid",
    maxActiveSandboxes: 1,
    executionConcurrency: 3,
    localImage: "python:3.12-slim",
    defaults: {
      runner: { cpu: 2, memoryGiB: 4, diskGiB: 10, autoStopMinutes: 30, autoDeleteMinutes: 60 },
      execution: { cpu: 2, memoryGiB: 4, diskGiB: 10, autoStopMinutes: 15, autoDeleteMinutes: 60 },
      evaluator: { cpu: 2, memoryGiB: 4, diskGiB: 10, autoStopMinutes: 15, autoDeleteMinutes: 60 },
      bridge: { cpu: 1, memoryGiB: 1, diskGiB: 3, autoStopMinutes: 10, autoDeleteMinutes: 60 },
    },
    ...overrides,
  };
}

function spec(operationId: string, reservedSandboxCount = 0): SandboxSpec {
  return {
    operationId,
    reservedSandboxCount,
    purpose: "execution",
    labels: {
      "forksafe.project": "forksafe",
      "forksafe.operation": operationId,
      "forksafe.purpose": "execution",
      "forksafe.investigation": "investigation",
    },
    resources: { cpu: 2, memoryGiB: 4, diskGiB: 10 },
    autoStopMinutes: 15,
    autoDeleteMinutes: 60,
  };
}

describe("Daytona providers", () => {
  let rows: ReturnType<typeof sandbox>[];
  let create: ReturnType<typeof vi.fn>;
  let fake: Record<string, any>;

  beforeEach(() => {
    rows = [];
    create = vi.fn(async (params: Record<string, any>) => {
      const item = sandbox(`sandbox-${rows.length + 1}`, params.labels);
      rows.push(item);
      return item;
    });
    fake = {
      create,
      get: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
      delete: vi.fn(async () => {}),
      list: vi.fn(async function* ({ labels }: { labels: Record<string, string> }) {
        for (const row of rows) {
          if (Object.entries(labels).every(([key, value]) => row.labels[key] === value)) yield row;
        }
      }),
    };
  });

  it("applies ownership labels and checks active plus ambiguous reservations against capacity", async () => {
    const provider = new CloudDaytonaProvider(fake as unknown as Daytona, config());
    const handle = await provider.create(spec("op-1"));
    expect(handle.labels).toMatchObject({
      "forksafe.project": "forksafe",
      "forksafe.operation": "op-1",
      "forksafe.purpose": "execution",
    });
    expect(create.mock.calls[0]?.[0].labels["forksafe.investigation"]).toBe("investigation");
    await expect(provider.create(spec("op-2"))).rejects.toBeInstanceOf(CapacityError);
    rows.splice(0);
    await expect(provider.create(spec("op-3", 1))).rejects.toBeInstanceOf(CapacityError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reports cloud readiness blocked without an API key and does not expose a failed request's key", async () => {
    const noKey = new CloudDaytonaProvider(fake as unknown as Daytona, config({ apiKey: undefined }));
    expect((await noKey.readiness()).mode).toBe("blocked");

    const key = "never-log-this-test-key";
    const client = {
      ...fake,
      create: vi.fn(async () => { throw new Error(`request failed with ${key}`); }),
    };
    const provider = new CloudDaytonaProvider(client as unknown as Daytona, config({ apiKey: key }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(provider.create(spec("op-failure"))).rejects.toThrow("daytona_create_ambiguous");
    expect(log).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).not.toContain(key);
    log.mockRestore();
  });

  it("reports local adapter readiness without invoking Docker", async () => {
    const localConfig = loadDaytonaConfig({ DAYTONA_MODE: "local" });
    const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const provider = new LocalDockerProvider(localConfig, execFile);
    expect((await provider.readiness()).mode).toBe("local");
    expect(execFile).not.toHaveBeenCalled();
  });
});
