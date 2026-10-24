import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type ActivityKind = "tool_call" | "tool_result" | "assistant" | "permission" | "usage" | "error" | "lifecycle";
export type ActivityEntry = {
  atMs: number;
  investigationId: string;
  environmentId: string;
  sessionId: string;
  kind: ActivityKind;
  summary: string;
  data?: Record<string, unknown>;
};

export function sanitize(text: string, secrets: string[] = []): string {
  let safe = text;
  for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join("[REDACTED]");
  safe = safe
    .replace(/Bearer\s+\S+/gi, "[REDACTED]")
    .replace(/\bfk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "[REDACTED]");
  return safe.slice(0, 500);
}

export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private readonly capacity: number;

  constructor(
    private readonly options: { filePath?: string; secrets?: string[]; capacity?: number } = {},
  ) {
    this.capacity = options.capacity ?? 1000;
  }

  async record(entry: ActivityEntry): Promise<void> {
    const safe: ActivityEntry = {
      ...entry,
      summary: sanitize(entry.summary, this.options.secrets),
      ...(entry.data ? { data: this.sanitizeData(entry.data) } : {}),
    };
    this.entries.push(safe);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    if (this.options.filePath) {
      await mkdir(dirname(this.options.filePath), { recursive: true });
      await appendFile(this.options.filePath, `${JSON.stringify(safe)}\n`, "utf8");
    }
  }

  recordCreate(entry: Omit<ActivityEntry, "data">, filePath: string, content: string): Promise<void> {
    return this.record({
      ...entry,
      summary: `created ${sanitize(filePath, this.options.secrets)}`,
      data: { path: sanitize(filePath, this.options.secrets), bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") },
    });
  }

  list(): ActivityEntry[] {
    return [...this.entries];
  }

  private sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitize(value, this.options.secrets) : value,
    ]));
  }
}
