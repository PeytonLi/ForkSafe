import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const committedDirectory = join(packageDirectory, "client", "module_bindings");
const candidates = [
  ...((process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "spacetime"))),
  join(homedir(), ".local", "bin", "spacetime"),
];
const spacetime = candidates.find((candidate) => existsSync(candidate));

if (!spacetime) {
  console.log("skipped: spacetime CLI not found");
  process.exit(0);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "forksafe-bindings-"));
const generatedDirectory = join(temporaryDirectory, "module_bindings");

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? filesUnder(root, path)
      : [relative(root, path)];
  }).sort();
}

try {
  const result = spawnSync(
    spacetime,
    [
      "generate",
      "--lang",
      "typescript",
      "--out-dir",
      generatedDirectory,
      "--module-path",
      ".",
      "-y",
    ],
    { cwd: packageDirectory, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`spacetime generate failed with exit code ${result.status}`);

  if (!existsSync(committedDirectory)) {
    throw new Error("Bindings are missing; run pnpm --filter @forksafe/spacetimedb generate");
  }
  const committedFiles = filesUnder(committedDirectory);
  const generatedFiles = filesUnder(generatedDirectory);
  const drift = committedFiles.length !== generatedFiles.length ||
    committedFiles.some((file, index) =>
      file !== generatedFiles[index] ||
      readFileSync(join(committedDirectory, file)).compare(
        readFileSync(join(generatedDirectory, generatedFiles[index] ?? "")),
      ) !== 0,
    );
  if (drift) {
    throw new Error("Bindings drifted; run pnpm --filter @forksafe/spacetimedb generate");
  }
  console.log("Bindings match generated SpacetimeDB output");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Binding check failed");
  process.exitCode = 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
