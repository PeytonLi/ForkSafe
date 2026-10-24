import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowlistedScopes = new Set(["read:jira-work"]);

describe("Forge manifest", () => {
  it("declares resolvable native Jira modules, resources, remote, and runtime", async () => {
    const manifest = parse(
      await readFile(resolve(appRoot, "manifest.yml"), "utf8"),
    ) as {
      modules: Record<string, Array<Record<string, unknown>>>;
      resources: Array<{ key: string; path: string }>;
      remotes: Array<{ key: string; operations: string[] }>;
      permissions: { scopes: string[] };
      app: { runtime: { name: string } };
    };
    expect(manifest).not.toHaveProperty("function");
    const functionModules = (manifest.modules.function ?? []) as Array<{
      key: string;
      handler: string;
    }>;
    expect(functionModules.length).toBeGreaterThan(0);
    const modules = [
      ...(manifest.modules["jira:issuePanel"] ?? []),
      ...(manifest.modules["jira:issueAction"] ?? []),
    ];
    expect(modules.length).toBeGreaterThanOrEqual(2);
    for (const module of modules) {
      expect(module.render).toBe("native");
      expect(module.key).toMatch(/^[a-zA-Z0-9_-]+$/);
      const resolver = module.resolver as { function?: string };
      expect(functionModules.some((item) => item.key === resolver.function)).toBe(
        true,
      );
    }

    const functions = new Map(functionModules.map((item) => [item.key, item]));
    const packageJson = JSON.parse(
      await readFile(resolve(appRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts.build).toBe("node scripts/build-resolver.mjs");
    const buildScriptPath = resolve(appRoot, "scripts/build-resolver.mjs");
    expect(existsSync(buildScriptPath)).toBe(true);
    expect(await readFile(buildScriptPath, "utf8")).toMatch(/src\/index\.ts/);
    const indexPath = resolve(appRoot, "src/index.ts");
    expect(await readFile(indexPath, "utf8")).toMatch(
      /export\s+const\s+handler\b/,
    );
    for (const item of functionModules) {
      expect(item.key).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(item.handler).toBe("generated/resolver.handler");
      expect(functions.has(item.key)).toBe(true);
    }

    const resources = new Map(manifest.resources.map((item) => [item.key, item.path]));
    for (const item of modules) {
      const resourceKey = item.resource as string;
      expect(resources.has(resourceKey)).toBe(true);
    }
    for (const path of resources.values()) {
      expect(existsSync(resolve(appRoot, path))).toBe(true);
    }

    const remote = manifest.remotes.find((item) => item.key === "forksafe-backend");
    expect(remote).toBeDefined();
    expect(remote!.key.length).toBeLessThanOrEqual(23);
    expect(remote!.key).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(remote!.operations).toContain("compute");
    expect(manifest.permissions.scopes.every((scope) => allowlistedScopes.has(scope))).toBe(
      true,
    );
    expect(manifest.app.runtime.name).toBe("nodejs22.x");
  });
});
