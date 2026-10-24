#!/usr/bin/env node
// Fetches the pinned MuJoCo Menagerie Franka Panda assets and writes a manifest.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { main, run, log } from "./lib/runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const PIN = "f3b6013629c7b94f8ee93fd977b161fa8350f9bc"; // google-deepmind/mujoco_menagerie
const dest = resolve(root, "assets/robots/mujoco_menagerie/franka_emika_panda");
const manifestPath = resolve(root, "assets/robots/manifest.json");

function treeHash(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else { h.update(relative(dir, p)); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest("hex");
}

main(async () => {
if (!existsSync(dest) || existsSync(resolve(root, "var/assets-clone"))) {
  const tmp = resolve(root, "var/assets-clone");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await run("git", ["clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", "https://github.com/google-deepmind/mujoco_menagerie.git", tmp]);
  await run("git", ["-C", tmp, "fetch", "--depth", "1", "origin", PIN]);
  await run("git", ["-C", tmp, "checkout", "--detach", PIN]);
  await run("git", ["-C", tmp, "sparse-checkout", "set", "--no-cone", "/franka_emika_panda/", "/LICENSE"]);
  mkdirSync(dest, { recursive: true });
  await run("cp", ["-r", `${tmp}/franka_emika_panda/.`, dest]);
  await run("cp", [`${tmp}/LICENSE`, `${dest}/LICENSE`]);
  rmSync(tmp, { recursive: true, force: true });
}
const sha = treeHash(dest);
if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).sha256 !== sha) {
  throw new Error("Robot asset SHA mismatch; refusing to replace the pinned manifest. Restore the asset tree and retry.");
}
writeFileSync(manifestPath, JSON.stringify({
  source: "https://github.com/google-deepmind/mujoco_menagerie",
  pinnedCommit: PIN,
  path: "franka_emika_panda",
  sha256: sha,
  license: "Apache-2.0 (see assets/robots/mujoco_menagerie/franka_emika_panda/LICENSE)",
  fetchedAt: new Date().toISOString(),
}, null, 2) + "\n");
log("assets sha256: " + sha);
});
