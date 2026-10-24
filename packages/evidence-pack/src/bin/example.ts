import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../canonical.js";
import { bundleFromDemo } from "../fixtures/demo.js";
import { renderEvidencePack } from "../render.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const demoPath = join(pkg, "..", "..", "apps", "web", "src", "fixtures", "demo.json");
const outDir = join(pkg, "examples");
mkdirSync(outDir, { recursive: true });

const bundle = bundleFromDemo(JSON.parse(readFileSync(demoPath, "utf8")));
writeFileSync(join(outDir, "demo-bundle.json"), `${canonicalJson(bundle)}\n`);
const result = renderEvidencePack(bundle);
writeFileSync(join(outDir, "demo-pack.html"), result.html);
for (const w of result.warnings) console.error(`warning [${w.code}]: ${w.message}`);
console.log(`examples/demo-bundle.json + examples/demo-pack.html (${result.bytes} bytes, verdict ${result.verdict.verdict})`);
