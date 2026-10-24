import { createServer, defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

/** Serves GET /api/readiness from the dev and preview servers. Reads the
 *  repo-root .env/.env.local plus process env; returns names, never values. */
type ReadinessModule = typeof import("./server/readiness");

/** server/readiness.ts imports TypeScript-source workspace packages, so it is
 *  loaded through Vite's SSR loader rather than Node's ESM loader. */
function readinessApi(mode: string): Plugin {
  let cache: { at: number; body: string } | undefined;
  let loader: ViteDevServer | undefined;
  const load = async (): Promise<ReadinessModule> => {
    loader ??= await createServer({ configFile: false, root: here, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
    return (await loader.ssrLoadModule("/server/readiness.ts")) as ReadinessModule;
  };
  const handler = async (_req: unknown, res: import("node:http").ServerResponse) => {
    if (!cache || Date.now() - cache.at > 15_000) {
      const env = { ...loadEnv(mode, root, ""), ...process.env };
      const { buildReadiness } = await load();
      const integrations = await buildReadiness(env);
      cache = { at: Date.now(), body: JSON.stringify({ integrations }) };
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(cache.body);
  };
  return {
    name: "forksafe-readiness-api",
    configureServer(server) {
      server.middlewares.use("/api/readiness", (req, res) => void handler(req, res));
    },
    buildEnd() {
      void loader?.close();
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/readiness", (req, res) => void handler(req, res));
    },
  };
}

export default defineConfig(({ mode }) => ({
  envDir: root,
  plugins: [react(), readinessApi(mode)],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  build: { chunkSizeWarningLimit: 900 },
}));
