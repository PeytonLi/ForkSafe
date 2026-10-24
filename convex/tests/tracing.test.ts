import { describe, expect, it } from "vitest";
import { parseTraceparent } from "../lib/tracing.js";

describe("parseTraceparent", () => {
  it("parses a valid sampled and unsampled traceparent", () => {
    expect(parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01")).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      sampled: true,
    });
    expect(parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-00")?.sampled).toBe(false);
  });

  it.each([
    null,
    "00-0123456789ABCDEF0123456789abcdef-0123456789abcdef-01",
    "00-00000000000000000000000000000000-0123456789abcdef-01",
    "00-0123456789abcdef0123456789abcdef-0000000000000000-01",
    "01-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01-extra",
    `00-${"1".repeat(32)}-${"2".repeat(16)}-01${"x".repeat(1)}`,
  ])("rejects invalid traceparent %s", (value) => {
    expect(parseTraceparent(value)).toBeNull();
  });
});
