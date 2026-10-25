import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultOverride } from "../scene";
import { SceneFields } from "./SceneFields";

describe("SceneFields default values", () => {
  it("renders divider height as 0.10", () => {
    const html = renderToStaticMarkup(createElement(SceneFields, {
      taskFamily: "divider_pick_place",
      values: defaultOverride("divider_pick_place"),
      onChange: () => {},
      seed: 0,
      onSeedChange: () => {},
      environments: 1,
      onEnvironmentsChange: () => {},
      onReset: () => {},
    }));
    const input = html.match(/<input\b[^>]*aria-label="Divider height value"[^>]*>/)?.[0];
    expect(input).toContain('value="0.10"');
  });

  it("renders gap width as 0.07", () => {
    const html = renderToStaticMarkup(createElement(SceneFields, {
      taskFamily: "push_through_gap",
      values: defaultOverride("push_through_gap"),
      onChange: () => {},
      seed: 0,
      onSeedChange: () => {},
      environments: 1,
      onEnvironmentsChange: () => {},
      onReset: () => {},
    }));
    const input = html.match(/<input\b[^>]*aria-label="Gap width value"[^>]*>/)?.[0];
    expect(input).toContain('value="0.07"');
  });

  it("uses toss-specific bin bounds and controls", () => {
    const html = renderToStaticMarkup(createElement(SceneFields, {
      taskFamily: "toss_into_bin",
      values: defaultOverride("toss_into_bin"),
      onChange: () => {},
      seed: 0,
      onSeedChange: () => {},
      environments: 1,
      onEnvironmentsChange: () => {},
      onReset: () => {},
    }));
    expect(html).toContain('aria-label="Object mass"');
    expect(html).toContain('aria-label="Bin distance"');
    expect(html).toContain('min="-0.15"');
    expect(html).toContain('max="0.05"');
    expect(html).toContain('value="0.08"');
  });
});
