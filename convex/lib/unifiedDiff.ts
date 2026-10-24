import { ConvexError } from "convex/values";

export function applyUnifiedDiff(source: string, diff: string): string {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines.shift() !== "--- a/task_controller.py" || lines.shift() !== "+++ b/task_controller.py") {
    throw new ConvexError("path_not_allowed");
  }
  const input = source.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let cursor = 0;
  let appliedHunk = false;
  while (lines.length) {
    const header = lines.shift()!;
    if (!header) continue;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(header);
    if (!match) throw new ConvexError("patch_invalid");
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newCount = Number(match[4] ?? 1);
    const start = oldCount === 0 ? oldStart : oldStart - 1;
    if (start < cursor || start > input.length) throw new ConvexError("patch_context_mismatch");
    output.push(...input.slice(cursor, start));
    cursor = start;
    let consumed = 0;
    let produced = 0;
    while (lines.length && /^[ +\-]/.test(lines[0]!)) {
      const line = lines.shift()!;
      const content = line.slice(1);
      if (line[0] === " ") {
        if (input[cursor] !== content) throw new ConvexError("patch_context_mismatch");
        output.push(content);
        cursor += 1;
        consumed += 1;
        produced += 1;
      } else if (line[0] === "-") {
        if (input[cursor] !== content) throw new ConvexError("patch_context_mismatch");
        cursor += 1;
        consumed += 1;
      } else {
        output.push(content);
        produced += 1;
      }
    }
    if (consumed !== oldCount || produced !== newCount) throw new ConvexError("patch_invalid");
    appliedHunk = true;
  }
  if (!appliedHunk) throw new ConvexError("patch_invalid");
  output.push(...input.slice(cursor));
  return output.join("\n");
}
