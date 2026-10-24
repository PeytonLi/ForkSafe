import { describe, expect, it } from "vitest";
import { ConfluenceClient, extractRequirements } from "../src/confluence.js";
import { fixtureTransport } from "../src/fixture-transport.js";

describe("Confluence requirements", () => {
  it("preserves the page revision and classifies versioned requirements", async () => {
    const client = new ConfluenceClient(fixtureTransport());
    const page = await client.getPage("123456789");
    const requirements = extractRequirements(page, 1_761_200_000_000);
    expect(page.version).toBe(7);
    expect(page.webUrl).toBe(
      "https://fixture.atlassian.net/spaces/FS/pages/123456789/Divider+requirements",
    );
    expect(requirements.items.map((item) => item.id)).toEqual([
      "123456789@v7#1",
      "123456789@v7#2",
      "123456789@v7#3",
      "123456789@v7#4",
    ]);
    expect(requirements.items.map((item) => item.kind)).toEqual([
      "checked_rule",
      "checked_rule",
      "checked_rule",
      "human_review",
    ]);
    expect(requirements.items[0]?.check).toEqual({
      metric: "timeoutSec",
      op: "<=",
      value: 30,
    });
    expect(requirements.items[1]?.check).toEqual({
      metric: "forbiddenContact",
      op: "none",
      value: "divider",
    });
    expect(requirements.items[2]?.check).toEqual({
      metric: "penetrationLimitM",
      op: "<=",
      value: 0.001,
    });
    expect(requirements.source.version).toBe(7);
  });
});
