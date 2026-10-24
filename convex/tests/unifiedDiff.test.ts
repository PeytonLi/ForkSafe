import { describe, expect, it } from "vitest";
import { applyUnifiedDiff } from "../lib/unifiedDiff.js";

describe("applyUnifiedDiff", () => {
  it("applies exact single-file context", () => {
    expect(applyUnifiedDiff("one\ntwo\nthree\n", [
      "--- a/task_controller.py",
      "+++ b/task_controller.py",
      "@@ -2,1 +2,1 @@",
      "-two",
      "+second",
      "",
    ].join("\n"))).toBe("one\nsecond\nthree\n");
  });

  it.each([
    ["rejects other paths", "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-one\n+two\n"],
    ["rejects inexact context", "--- a/task_controller.py\n+++ b/task_controller.py\n@@ -1 +1 @@\n-wrong\n+two\n"],
    ["rejects malformed counts", "--- a/task_controller.py\n+++ b/task_controller.py\n@@ -1,2 +1 @@\n-one\n+two\n"],
    ["rejects extra file headers", "--- a/task_controller.py\n+++ b/task_controller.py\n@@ -1 +1 @@\n-one\n+two\n--- a/other\n+++ b/other\n"],
  ])("%s", (_name, diff) => {
    expect(() => applyUnifiedDiff("one\n", diff)).toThrow();
  });
});
