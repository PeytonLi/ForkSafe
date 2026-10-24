import { describe, expect, it } from "vitest";
import { jsonForScript, recomputeSuite, redactString, renderDiff } from "../src/index.js";

describe("recomputeSuite", () => {
  it("matches the evaluator: invalid beats failed, empty suite never passes", () => {
    expect(recomputeSuite([]).status).toBe("failed");
    expect(recomputeSuite([]).allRequiredPassed).toBe(false);
    expect(recomputeSuite([{ caseId: "a", status: "failed", failureKinds: [] }, { caseId: "b", status: "invalid", failureKinds: [] }]).status).toBe("invalid");
    expect(recomputeSuite([{ caseId: "a", status: "running", failureKinds: [] }]).status).toBe("pending");
    expect(recomputeSuite([1, 3, 2, 10].map((t, i) => ({ caseId: `c${i}`, status: "passed" as const, completionTimeSec: t, failureKinds: [] }))).medianCompletionTimeSec).toBe(2.5);
  });
});

describe("renderDiff", () => {
  it("counts lines, escapes content and highlights python tokens", () => {
    const { html, stats } = renderDiff("--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@ def f():\n-    return '<b>'\n+    return 2  # fixed\n");
    expect(stats).toEqual({ files: 1, added: 1, removed: 1 });
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain('<span class="t-k">return</span>');
    expect(html).toContain('<span class="t-c"># fixed</span>');
    expect(html).toContain('<span class="t-f">f</span>');
  });
});

describe("script-safe JSON", () => {
  it("cannot close the script element", () => {
    const s = jsonForScript({ a: "</script><!-- \u2028" });
    expect(s).not.toMatch(/<|>|\u2028/);
    expect(JSON.parse(s).a).toBe("</script><!-- \u2028");
  });
});

describe("redactString", () => {
  it("is idempotent and leaves hex digests and uuids alone", () => {
    const hex = "bcf7166c368900f13a2d4cd66f380b1502c2414960f6820b19d8774b0a15189a";
    const text = `sha ${hex} id 3b7d9303-7082-4b73-a3b6-1391b3e2fc4d Bearer abcdefghijklmnop`;
    const once = redactString(text);
    expect(once).toContain(hex);
    expect(once).toContain("3b7d9303-7082-4b73-a3b6-1391b3e2fc4d");
    expect(once).toContain("Bearer [REDACTED:credential]");
    expect(redactString(once)).toBe(once);
  });
});
