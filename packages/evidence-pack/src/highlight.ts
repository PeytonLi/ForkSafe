import { esc } from "./html.js";

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "),
);

const TOKEN =
  /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/g;

/** Minimal Python-ish token highlighter: comments, strings, numbers,
 *  keywords, and the name after `def`/`class`. Output is escaped HTML. */
export function highlightCode(line: string): string {
  let out = "";
  let prevKeyword = "";
  for (const m of line.matchAll(TOKEN)) {
    const [text, comment, str, num, ident] = m;
    if (comment) out += `<span class="t-c">${esc(comment)}</span>`;
    else if (str) out += `<span class="t-s">${esc(str)}</span>`;
    else if (num) out += `<span class="t-n">${esc(num)}</span>`;
    else if (ident) {
      if (PY_KEYWORDS.has(ident)) out += `<span class="t-k">${esc(ident)}</span>`;
      else if (prevKeyword === "def" || prevKeyword === "class") out += `<span class="t-f">${esc(ident)}</span>`;
      else out += esc(ident);
      prevKeyword = ident;
      continue;
    } else out += esc(text);
    if (!/^\s+$/.test(text)) prevKeyword = "";
  }
  return out;
}

export interface DiffStats {
  files: number;
  added: number;
  removed: number;
}

/** Renders a unified diff as escaped, highlighted HTML lines. */
export function renderDiff(text: string): { html: string; stats: DiffStats } {
  const stats: DiffStats = { files: 0, added: 0, removed: 0 };
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const rows = lines.map((line) => {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      if (line.startsWith("+++ ")) stats.files += 1;
      return `<span class="d-l d-file">${esc(line)}</span>`;
    }
    if (line.startsWith("@@")) {
      const m = /^(@@[^@]*@@)(.*)$/.exec(line);
      return m
        ? `<span class="d-l d-hunk">${esc(m[1] as string)}<span class="d-ctx">${highlightCode(m[2] as string)}</span></span>`
        : `<span class="d-l d-hunk">${esc(line)}</span>`;
    }
    if (line.startsWith("+")) {
      stats.added += 1;
      return `<span class="d-l d-add"><span class="d-sign">+</span>${highlightCode(line.slice(1))}</span>`;
    }
    if (line.startsWith("-")) {
      stats.removed += 1;
      return `<span class="d-l d-del"><span class="d-sign">-</span>${highlightCode(line.slice(1))}</span>`;
    }
    if (line.startsWith("\\")) return `<span class="d-l d-meta">${esc(line)}</span>`;
    return `<span class="d-l"><span class="d-sign"> </span>${highlightCode(line.slice(1))}</span>`;
  });
  return { html: rows.join(""), stats };
}
