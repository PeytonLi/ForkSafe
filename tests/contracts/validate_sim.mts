import { readFileSync } from "node:fs";
import {
  FailureKind,
  SimCase,
  SimFrame,
  SimRunResult,
} from "../../packages/contracts/src/index.js";

type SchemaName = "case" | "result" | "frame";

const [schemaName, inputPath] = process.argv.slice(2) as [SchemaName, string];
const input: unknown = JSON.parse(readFileSync(inputPath, "utf8"));

function issueList(issues: Array<{ path: PropertyKey[]; code: string; message: string }>) {
  return issues.map((issue) => ({
    path: issue.path.map(String),
    code: issue.code,
    message: issue.message,
  }));
}

let output: Record<string, unknown>;
if (schemaName === "case") {
  const parsed = SimCase.safeParse(input);
  output = parsed.success
    ? {
        valid: true,
        errors: [],
        strippedKeys: Object.keys(input as object).filter(
          (key) => !(key in parsed.data),
        ),
        shape: {
          keys: Object.keys(parsed.data),
          suite: parsed.data.suite,
          seed: parsed.data.seed,
          sceneOverrides: parsed.data.sceneOverrides,
        },
      }
    : { valid: false, errors: issueList(parsed.error.issues), strippedKeys: [] };
} else if (schemaName === "frame") {
  const parsed = SimFrame.safeParse(input);
  output = parsed.success
    ? {
        valid: true,
        errors: [],
        strippedKeys: Object.keys(input as object).filter(
          (key) => !(key in parsed.data),
        ),
        shape: { keys: Object.keys(parsed.data), bodies: parsed.data.bodies.length },
      }
    : { valid: false, errors: issueList(parsed.error.issues), strippedKeys: [] };
} else if (schemaName === "result") {
  const parsed = SimRunResult.safeParse(input);
  output = parsed.success
    ? {
        valid: true,
        errors: [],
        strippedKeys: Object.keys(input as object).filter(
          (key) => !(key in parsed.data),
        ),
        shape: {
          keys: Object.keys(parsed.data),
          frameCount: parsed.data.frames.length,
          firstFrameKeys: parsed.data.frames[0]
            ? Object.keys(parsed.data.frames[0])
            : [],
          completed: parsed.data.completed,
          completionTimeSec: parsed.data.completionTimeSec,
        },
        failureKinds: parsed.data.failureKinds,
        knownFailureKinds: FailureKind.options,
        invalidFailureKinds: parsed.data.failureKinds.filter(
          (kind) => !FailureKind.safeParse(kind).success,
        ),
      }
    : { valid: false, errors: issueList(parsed.error.issues), strippedKeys: [] };
} else {
  output = {
    valid: false,
    errors: [{ path: [], code: "unknown_schema", message: String(schemaName) }],
    strippedKeys: [],
  };
}

console.log(JSON.stringify(output));
