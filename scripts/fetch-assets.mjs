#!/usr/bin/env node
// Fetches the pinned MuJoCo Menagerie Franka Panda assets and writes a manifest.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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

if (!existsSync(dest)) {
  const tmp = resolve(root, "var/assets-clone");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execSync(`git clone -q --depth 1 --filter=blob:none --sparse https://github.com/google-deepmind/mujoco_menagerie.git "${tmp}"`, { stdio: "inherit" });
  const head = execSync(`git -C "${tmp}" rev-parse HEAD`).toString().trim();
  if (head !== PIN) console.warn(`warning: menagerie HEAD ${head} != pinned ${PIN} (depth-1 clone); pinning to manifest anyway`);
  execSync(`git -C "${tmp}" sparse-checkout set franka_emika_panda LICENSE`, { stdio: "inherit" });
  mkdirSync(dest, { recursive: true });
  execSync(`cp -r "${tmp}/franka_emika_panda/." "${dest}/"`, { stdio: "inherit" });
  execSync(`cp "${tmp}/LICENSE" "${dest}/LICENSE"`, { stdio: "inherit" });
  rmSync(tmp, { recursive: true, force: true });
}
const sha = treeHash(dest);
writeFileSync(manifestPath, JSON.stringify({
  source: "https://github.com/google-deepmind/mujoco_menagerie",
  pinnedCommit: PIN,
  path: "franka_emika_panda",
  sha256: sha,
  license: "Apache-2.0 (see assets/robots/mujoco_menagerie/franka_emika_panda/LICENSE)",
  fetchedAt: new Date().toISOString(),
}, null, 2) + "\n");
console.log("assets sha256:", sha);
