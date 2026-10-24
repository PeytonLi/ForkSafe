import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";

const baseUrl = process.env.CONVEX_SITE_URL;
if (!baseUrl) throw new Error("CONVEX_SITE_URL is required.");
const url = new URL(baseUrl);
if (url.protocol !== "https:") {
  throw new Error("CONVEX_SITE_URL must use https.");
}

const manifestPath = new URL("../manifest.yml", import.meta.url);
const manifest = parse(await readFile(manifestPath, "utf8"));
const remote = manifest.remotes?.find((item) => item.key === "forksafe-backend");
if (!remote) throw new Error("Manifest remote forksafe-backend was not found.");
remote.baseUrl = url.toString().replace(/\/$/, "");
await writeFile(manifestPath, stringify(manifest));
