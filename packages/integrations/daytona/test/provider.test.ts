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
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("domainAllowList");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("outboundProxyUrl");
    await expect(provider.create(spec("op-2"))).rejects.toBeInstanceOf(CapacityError);
    rows.splice(0);
    await expect(provider.create(spec("op-3", 1))).rejects.toBeInstanceOf(CapacityError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("passes runner network settings from the environment to the create request", async () => {
    const runnerConfig = loadDaytonaConfig({
      DAYTONA_MODE: "cloud",
      DAYTONA_RUNNER_DOMAIN_ALLOWLIST: " api.factory.ai, app.factory.ai ",
      DAYTONA_RUNNER_OUTBOUND_PROXY_URL: "https://probe-user:probe-pass@proxy.example",
    });
    const base = spec("op-network");
    const runnerSpec: SandboxSpec = {
      ...base,
      purpose: "runner",
      labels: { ...base.labels, "forksafe.purpose": "runner" },
    };
    const provider = new CloudDaytonaProvider(fake as unknown as Daytona, runnerConfig);

    await provider.create(runnerSpec);

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      domainAllowList: "api.factory.ai,app.factory.ai",
      outboundProxyUrl: "https://probe-user:probe-pass@proxy.example",
    });
  });

  it("rejects mutually exclusive runner network settings before contacting Daytona", async () => {
    const base = spec("op-network-conflict");
    const provider = new CloudDaytonaProvider(fake as unknown as Daytona, config());
    const invalidSpec: SandboxSpec = {
      ...base,
      purpose: "runner",
      labels: { ...base.labels, "forksafe.purpose": "runner" },
      networkPolicy: {
        purpose: "runner",
        domainAllowList: ["api.factory.ai"],
        networkBlockAll: true,
      },
    };

    await expect(provider.create(invalidSpec)).rejects.toThrow("daytona_network_policy_conflict");
    expect(fake.list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not expose proxy URL userinfo in Daytona errors or logs", async () => {
    const proxyUrl = "https://probe-user:probe-pass@proxy.example";
    const client = {
      ...fake,
      create: vi.fn(async () => { throw new Error(`request failed for ${proxyUrl}`); }),
      get: vi.fn(async () => { throw new Error(`request failed for ${proxyUrl}`); }),
    };
    const provider = new CloudDaytonaProvider(client as unknown as Daytona, config());
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = spec("op-proxy-error");
    const runnerSpec: SandboxSpec = {
      ...base,
      purpose: "runner",
      labels: { ...base.labels, "forksafe.purpose": "runner" },
      networkPolicy: { purpose: "runner", outboundProxyUrl: proxyUrl },
    };

    const rejectedError = async (operation: Promise<unknown>) => {
      try {
        await operation;
      } catch (error) {
        if (error instanceof Error) return error;
      }
      throw new Error("expected_daytona_operation_to_fail");
    };

    try {
      const createError = await rejectedError(provider.create(runnerSpec));
      expect(createError.message).toBe("daytona_create_ambiguous");
      expect(createError.message).not.toContain("probe-user");
      expect(createError.message).not.toContain("probe-pass");
      expect(createError.message).not.toContain(proxyUrl);

      const getError = await rejectedError(provider.get({ provider: "daytona", id: "sandbox-proxy-error" }));
      expect(getError.message).toBe("daytona_request_failed:Error");
      expect(getError.message).not.toContain("probe-user");
      expect(getError.message).not.toContain("probe-pass");
      expect(getError.message).not.toContain(proxyUrl);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
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
