import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/index.js";
import { demoBundle } from "./helpers.js";

const pkg = join(__dirname, "..");
const tsx = join(pkg, "node_modules", ".bin", "tsx");
const run = (args: string[]) => spawnSync(tsx, ["src/bin/pack.ts", ...args], { cwd: pkg, encoding: "utf8", env: { ...process.env, INIT_CWD: "" } });

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "evpack-"));

  it("writes the pack and reports warnings on stderr", () => {
    const inPath = join(dir, "bundle.json");
    writeFileSync(inPath, canonicalJson(demoBundle()));
    const r = run(["--in", inPath, "--out", join(dir, "pack.html")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/verdict candidate_passed/);
    expect(r.stderr).toMatch(/median_mismatch/);
    expect(readFileSync(join(dir, "pack.html"), "utf8")).toMatch(/^<!doctype html>/);
    expect(run(["--in", inPath, "--out", join(dir, "p2.html"), "--fail-on-warning"]).status).toBe(3);
  });

  it("refuses tampered bundles with exit 1 and no HTML", () => {
    const b = demoBundle();
    b.candidates[0].diff.text += "+tampered\n";
    const inPath = join(dir, "bad.json");
    writeFileSync(inPath, JSON.stringify(b));
    const r = run(["--in", inPath, "--out", join(dir, "bad.html")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused \[hash_mismatch\]/);
    expect(() => readFileSync(join(dir, "bad.html"))).toThrow();
  });

  it("rejects bad usage and invalid JSON", () => {
    expect(run([]).status).toBe(2);
    expect(run(["--in", "x", "--out", "y", "--max-bytes", "-4"]).status).toBe(2);
    const p = join(dir, "notjson.json");
    writeFileSync(p, "{");
    const r = run(["--in", p, "--out", join(dir, "n.html")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/invalid_bundle/);
  });
});

describe("example generator", () => {
  it("regenerates examples/demo-pack.html deterministically from the web fixture", () => {
    execFileSync(tsx, ["src/bin/example.ts"], { cwd: pkg, stdio: "pipe" });
    const first = readFileSync(join(pkg, "examples", "demo-pack.html"), "utf8");
    execFileSync(tsx, ["src/bin/example.ts"], { cwd: pkg, stdio: "pipe" });
    expect(readFileSync(join(pkg, "examples", "demo-pack.html"), "utf8")).toBe(first);
    expect(first).toContain("Panda clips divider while carrying cube");
  });
});
