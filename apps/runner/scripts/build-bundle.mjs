// Bundles apps/runner into one self-contained ESM file for the runner sandbox.
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../dist/runner.mjs");
await mkdir(dirname(out), { recursive: true });
await build({
  entryPoints: [resolve(here, "../src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: out,
  sourcemap: false,
  minify: false,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
console.log(`runner bundle written to ${out}`);
