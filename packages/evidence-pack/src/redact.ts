/** Secret-pattern redaction applied to every string before it is rendered
 *  or embedded. Hex digests and UUIDs are deliberately not matched. */

export interface RedactionOptions {
  /** Redact e-mail addresses too (default true: packs get attached to Jira). */
  redactEmails?: boolean;
}

export interface RedactionStats {
  total: number;
  byRule: Record<string, number>;
  /** JSON-pointer-ish paths of strings that were changed. */
  paths: string[];
}

interface Rule {
  name: string;
  pattern: RegExp;
  /** Replacement keeps a non-secret prefix (e.g. the header name). */
  replace: (match: string, ...groups: string[]) => string;
}

const MARK = (name: string) => `[REDACTED:${name}]`;

const RULES: Rule[] = [
  {
    name: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: () => MARK("private_key"),
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => MARK("jwt"),
  },
  {
    name: "auth_header",
    pattern: /\b(Bearer|Basic|ApiKey|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme, ws) => `${scheme}${ws}${MARK("credential")}`,
  },
  {
    name: "url_credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi,
    replace: (_m, scheme) => `${scheme}${MARK("credentials")}@`,
  },
  {
    name: "vendor_key",
    pattern:
      /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|fk-[A-Za-z0-9_-]{16,}|dtn_[A-Za-z0-9_-]{16,}|ATATT[A-Za-z0-9_=-]{20,})\b/g,
    replace: () => MARK("api_key"),
  },
  {
    name: "assignment",
    // key = value / "key": "value" for secret-ish names.
    pattern:
      /(["']?\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key|deploy[_-]?key|credential)s?["']?\s*[:=]\s*["']?)(?![0-9.]+(?:[\s"',;}]|$))([^\s"',;}{]{8,})/gi,
    replace: (_m, prefix) => `${prefix}${MARK("secret")}`,
  },
];

const EMAIL: Rule = {
  name: "email",
  pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  replace: () => MARK("email"),
};

export function redactString(
  input: string,
  options: RedactionOptions = {},
  stats?: RedactionStats,
  path = "",
): string {
  const rules = options.redactEmails === false ? RULES : [...RULES, EMAIL];
  let out = input;
  for (const rule of rules) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      if (match.includes("[REDACTED:")) return match;
      if (stats) stats.byRule[rule.name] = (stats.byRule[rule.name] ?? 0) + 1;
      if (stats) stats.total += 1;
      const groups = args.slice(1, -2).map((g) => (typeof g === "string" ? g : ""));
      return rule.replace(match, ...groups);
    });
  }
  if (stats && out !== input) stats.paths.push(path || "/");
  return out;
}

export function emptyStats(): RedactionStats {
  return { total: 0, byRule: {}, paths: [] };
}

/** Deep-redacts every string (keys included) in a JSON-like value. */
export function redactDeep<T>(value: T, options: RedactionOptions = {}, stats = emptyStats()): T {
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === "string") return redactString(v, options, stats, path);
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}/${i}`));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const key = redactString(k, options, stats, `${path}/<key>`);
        out[key] = walk(item, `${path}/${key}`);
      }
      return out;
    }
    return v;
  };
  return walk(value, "") as T;
}
