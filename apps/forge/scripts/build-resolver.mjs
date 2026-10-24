import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(appRoot, "src/generated/resolver.js");

await mkdir(dirname(outputPath), { recursive: true });
await build({
  entryPoints: [resolve(appRoot, "src/index.ts")],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@forge/*"],
});
