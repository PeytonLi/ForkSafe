import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleFromDemo } from "../src/index.js";

export const DEMO_PATH = join(__dirname, "..", "..", "..", "apps", "web", "src", "fixtures", "demo.json");
const demo = JSON.parse(readFileSync(DEMO_PATH, "utf8"));

/** Fresh deep copy of the demo-derived bundle for each test to mutate. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function demoBundle(): any {
  return structuredClone(bundleFromDemo(demo));
}

export function appendixOf(html: string): any {
  const m = /<script type="application\/json" id="fs-bundle">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no appendix");
  return JSON.parse(m[1] as string);
}

export const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
