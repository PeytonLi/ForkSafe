import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ActivityLog, sanitize } from "../src/activity-log.js";

describe("ActivityLog", () => {
  it("redacts provided secrets and token patterns, and truncates", () => {
    expect(sanitize("my-secret Bearer abc fk-abcdefgh sk-abcdefgh AKIA1234567890ABCDEF api_key=abc", ["my-secret"]))
      .toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
    expect(sanitize("x".repeat(510))).toHaveLength(500);
  });

  it("logs created content only as path, byte length, and digest", async () => {
    const log = new ActivityLog();
    await log.recordCreate({
      atMs: 1, investigationId: "i", environmentId: "e", sessionId: "s",
      kind: "permission", summary: "create",
    }, "src/file.txt", "content");
    const entry = log.list()[0]!;
    expect(entry.data).toEqual({
      path: "src/file.txt", bytes: 7,
      sha256: createHash("sha256").update("content").digest("hex"),
    });
    expect(JSON.stringify(entry)).not.toContain("content");
  });
});
