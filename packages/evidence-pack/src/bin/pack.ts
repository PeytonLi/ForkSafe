#!/usr/bin/env -S npx tsx
import { readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EvidencePackError } from "../errors.js";
import { DEFAULT_MAX_BYTES, renderEvidencePack } from "../render.js";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;

const USAGE = `usage: pnpm --filter @forksafe/evidence-pack run pack --in bundle.json --out pack.html
  [--max-bytes N] [--max-frames N] [--keep-emails] [--fail-on-warning]`;

function main(argv: string[]): number {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        in: { type: "string" },
        out: { type: "string" },
        "max-bytes": { type: "string" },
        "max-frames": { type: "string" },
        "keep-emails": { type: "boolean", default: false },
        "fail-on-warning": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.in || !args.out) {
    console.error(USAGE);
    return 2;
  }
  const int = (v: string | undefined, name: string, dflt: number) => {
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
    return n;
  };
  const inPath = resolve(process.env.INIT_CWD ?? process.cwd(), args.in);
  const outPath = resolve(process.env.INIT_CWD ?? process.cwd(), args.out);
  try {
    const maxBytes = int(args["max-bytes"], "max-bytes", DEFAULT_MAX_BYTES);
    const maxFrames = int(args["max-frames"], "max-frames", 240);
    if (statSync(inPath).size > MAX_INPUT_BYTES) {
      throw new EvidencePackError("input_too_large", [`input exceeds ${MAX_INPUT_BYTES} bytes`]);
    }
    let bundle: unknown;
    try {
      bundle = JSON.parse(readFileSync(inPath, "utf8"));
    } catch {
      throw new EvidencePackError("invalid_bundle", ["input is not valid JSON"]);
    }
    const result = renderEvidencePack(bundle, {
      maxBytes,
      maxFramesPerReplay: maxFrames,
      redactEmails: !args["keep-emails"],
    });
    const tmp = resolve(dirname(outPath), `.${Date.now()}.evidence-pack.tmp`);
    writeFileSync(tmp, result.html, "utf8");
    renameSync(tmp, outPath);
    for (const w of result.warnings) console.error(`warning [${w.code}]: ${w.message}`);
    console.log(`wrote ${outPath} (${result.bytes} bytes, verdict ${result.verdict.verdict}, ${result.redactions.total} redactions)`);
    return args["fail-on-warning"] && result.warnings.length ? 3 : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof EvidencePackError) {
      console.error(`refused [${e.code}]`);
      for (const issue of e.issues) console.error(`  - ${issue}`);
      return 1;
    }
    const code = (e as NodeJS.ErrnoException).code;
    console.error(code ? `io error: ${code}` : "unexpected error");
    return 1;
  }
}

class UsageError extends Error {}

process.exitCode = main(process.argv.slice(2).filter((a) => a !== "--"));
