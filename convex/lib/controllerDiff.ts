/** JS approximation of controllers/diff.py: top-level `def` blocks are compared
 *  by normalized text; everything else is the `<module>` body. */

type Block = { name: string; text: string };

function normalize(text: string): string {
  return text.split("\n").map((line) => line.replace(/\s+#.*$/, "").replace(/\s+$/, "")).filter((line) => line.trim() !== "").join("\n");
}

export function splitTopLevel(source: string): { functions: Map<string, string>; module: string } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const functions = new Map<string, string>();
  const moduleLines: string[] = [];
  let current: Block | null = null;
  const flush = () => {
    if (current) functions.set(current.name, normalize(current.text));
    current = null;
  };
  for (const line of lines) {
    const match = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (match) {
      flush();
      current = { name: match[1]!, text: `${line}\n` };
      continue;
    }
    if (current && (line === "" || /^\s/.test(line))) {
      current.text += `${line}\n`;
      continue;
    }
    if (/^@/.test(line)) { flush(); moduleLines.push(line); continue; }
    flush();
    moduleLines.push(line);
  }
  flush();
  return { functions, module: normalize(moduleLines.join("\n")) };
}

export function changedFunctions(baseline: string, candidate: string): string[] {
  const left = splitTopLevel(baseline);
  const right = splitTopLevel(candidate);
  const names = new Set([...left.functions.keys(), ...right.functions.keys()]);
  const changed = [...names].filter((name) => left.functions.get(name) !== right.functions.get(name));
  if (left.module !== right.module) changed.push("<module>");
  return changed.sort();
}

/** Minimal unified diff (LCS based) for review display. */
export function unifiedDiff(baseline: string, candidate: string, fromName = "baseline/task_controller.py", toName = "candidate/task_controller.py"): string {
  const a = baseline.replace(/\r\n/g, "\n").split("\n");
  const b = candidate.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: { kind: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: " ", line: a[i]! }); i += 1; j += 1; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ kind: "-", line: a[i]! }); i += 1; }
    else { ops.push({ kind: "+", line: b[j]! }); j += 1; }
  }
  while (i < n) { ops.push({ kind: "-", line: a[i]! }); i += 1; }
  while (j < m) { ops.push({ kind: "+", line: b[j]! }); j += 1; }
  if (!ops.some((op) => op.kind !== " ")) return "";
  const out = [`--- ${fromName}`, `+++ ${toName}`];
  const context = 3;
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === " ") { index += 1; continue; }
    const start = Math.max(0, index - context);
    let end = index;
    let lastChange = index;
    while (end < ops.length && end - lastChange <= context * 2) {
      if (ops[end]!.kind !== " ") lastChange = end;
      end += 1;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const hunk = ops.slice(start, end);
    const oldStart = ops.slice(0, start).filter((op) => op.kind !== "+").length + 1;
    const newStart = ops.slice(0, start).filter((op) => op.kind !== "-").length + 1;
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
    index = end;
  }
  return `${out.join("\n")}\n`;
}

export async function sha256Hex(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
