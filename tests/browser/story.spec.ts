import { expect, test, type Page } from "../../apps/web/e2e/playwright";

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page must not scroll horizontally").toBeLessThanOrEqual(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test("browser story: readiness, fixture investigation, replay scrub, review", async ({ page }, info) => {
  await page.goto("/");

  // The compact status pill makes fixture mode and integration details available.
  const strip = page.getByTestId("readiness-strip");
  const statusButton = strip.getByRole("button").first();
  await statusButton.focus();
  await expect(page.getByRole("dialog", { name: "Integration status" })).toHaveCount(0);
  await statusButton.click();
  const status = page.getByRole("dialog", { name: "Integration status" });
  await expect(status).toContainText("Showing recorded fixture data, not live results");
  await expect(status.getByTestId("readiness-web-data")).toContainText("fixture");
  await expect(status.getByTestId("readiness-convex")).toBeVisible();
  await expect(statusButton).toHaveAttribute("aria-label", /configured/);
  for (const name of ["convex", "spacetimedb", "daytona", "factory", "elastic", "atlassian_jira"]) {
    const row = status.getByTestId(`readiness-${name}`);
    await expect(row).toHaveAttribute("data-mode", /^(live|local|fixture|blocked|not_implemented)$/);
    const mode = await row.getAttribute("data-mode");
    const probed = await row.getAttribute("data-probed");
    expect(["true", "false"]).toContain(probed);
    const label = mode === "blocked" ? "Blocked"
      : mode === "not_implemented" ? "Not implemented"
        : mode === "fixture" ? "Fixture"
          : probed === "true" ? "Live" : "Configured";
    await expect(row.getByText(label, { exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(status).toHaveCount(0);

  // Open the recorded investigation.
  if (info.project.name === "mobile") {
    await page.getByLabel("Switch investigation").selectOption("3b7d9303-7082-4b73-a3b6-1391b3e2fc4d");
  } else {
    await page.getByRole("button", { name: /Panda clips divider/ }).click();
  }
  await expect(page.getByTestId("investigation-title")).toHaveText(/Panda clips divider/);
  await expect(page.getByTestId("baseline-seed")).toHaveText("1042");

  // Scrub the baseline replay to the failure and check the frame readout follows.
  const viewer = page.getByTestId("baseline-replay");
  const scrubber = viewer.getByTestId("replay-scrubber");
  await expect(scrubber).toBeVisible();
  await scrubber.fill("4.1");
  await expect(viewer.getByTestId("frame-readout")).toContainText("t=4.10 s");
  await expect(viewer.getByText(/Contact cube↔divider/)).toBeVisible();
  await scrubber.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(viewer.getByTestId("frame-readout")).toContainText("t=4.00 s");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath(`capture-${info.project.name}.png`), fullPage: true });

  // Scenario controls stay out of the way until explicitly opened.
  const capturedFailure = page.getByRole("region", { name: "Captured failure" });
  await expect(capturedFailure.getByTestId("open-scenario")).toBeVisible();
  await capturedFailure.getByTestId("open-scenario").click();
  const scenario = page.getByRole("dialog", { name: "Edit scenario" });
  await expect(scenario).toBeVisible();
  for (const group of ["Divider", "Cube", "Target", "Run"]) await expect(scenario.getByRole("group", { name: group })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press("Escape");
  await expect(scenario).toHaveCount(0);

  // Environment grid and evidence feed with provenance.
  if (info.project.name === "mobile") {
    await page.getByRole("combobox", { name: "Investigation sections" }).selectOption("environments");
  } else {
    await page.getByRole("tab", { name: "Environments" }).click();
  }
  await expect(page.getByTestId("env-tile-1")).toBeVisible();
  await expect(page.getByTestId("env-tile-3")).toBeVisible();
  await page.getByTestId("env-tile-1").getByRole("button", { name: /^Timeline/ }).click();
  await expect(page.getByTestId("env-tile-1").getByRole("listitem").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath(`environments-${info.project.name}.png`), fullPage: true });

  if (info.project.name === "mobile") {
    await page.getByRole("combobox", { name: "Investigation sections" }).selectOption("evidence");
  } else {
    await page.getByRole("tab", { name: "Evidence" }).focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("finding").first()).toContainText(/Env \d/);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath(`evidence-${info.project.name}.png`), fullPage: true });

  // Candidate comparison: synced panes, then review bound to the exact hash.
  if (info.project.name === "mobile") {
    await page.getByRole("combobox", { name: "Investigation sections" }).selectOption("compare");
  } else {
    await page.getByRole("tab", { name: "Compare & review" }).click();
  }
  const subtabs = page.getByTestId("compare-subtabs");
  await expect(page.getByRole("radiogroup", { name: "Candidate" }).getByRole("radio")).toHaveCount(2);
  await expect(subtabs.getByRole("tab", { name: "Replay" })).toHaveAttribute("aria-selected", "true");
  const cmp = page.getByTestId("comparison-replay");
  await expect(cmp.getByTestId("replay-viewer")).toHaveCount(2);
  await cmp.getByTestId("replay-scrubber").fill("5");
  await expect(cmp.getByTestId("frame-readout").nth(0)).toContainText("t=5.00 s");
  await expect(cmp.getByTestId("frame-readout").nth(1)).toContainText("t=5.00 s");

  await subtabs.getByRole("tab", { name: "Results" }).click();
  await expect(page.getByTestId("suite-public")).toContainText("10/10 passed");
  await expect(page.getByTestId("suite-withheld")).toBeVisible();

  await subtabs.getByRole("tab", { name: "Change" }).click();
  await expect(page.getByTestId("changed-functions")).toContainText("plan_transit");
  const sha = (await page.getByTestId("candidate-sha").textContent())!.trim();
  expect(sha).toMatch(/^[0-9a-f]{64}$/);
  await page.getByText("Exact diff").click();
  await expect(page.getByTestId("candidate-diff")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath(`compare-${info.project.name}.png`), fullPage: true });

  await subtabs.getByRole("tab", { name: "Review" }).click();
  const review = page.getByTestId("review-panel");
  await expect(review.getByTestId("submit-review")).toBeDisabled();
  await expect(review).toContainText("Choose a decision to enable your review");
  const decisions = review.getByRole("radiogroup", { name: "Decision" });
  await expect(decisions.getByRole("radio")).toHaveCount(3);
  await expect(decisions).toContainText("Accept this version for engineering review");
  await expect(decisions).toContainText("Ask the team to make another change before review.");
  await expect(decisions).toContainText("Do not advance this candidate.");
  const approve = decisions.getByRole("radio", { name: "Approve for engineering review" });
  await approve.focus();
  await page.keyboard.press("ArrowRight");
  await expect(decisions.getByRole("radio", { name: "Needs changes" })).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(approve).toBeChecked();
  await review.getByLabel("Approve for engineering review").check();
  await review.getByLabel("Notes (optional)").fill("Clears divider on all public and withheld cases.");
  await review.getByTestId("submit-review").click();
  await expect(review.getByTestId("review-history")).toContainText("Approved");
  await expect(review.getByTestId("review-history")).toContainText(sha.slice(0, 12));
});

test("status popover opens on click and closes outside", async ({ page }, info) => {
  await page.goto("/");
  const trigger = page.getByTestId("readiness-strip").getByRole("button");
  await trigger.focus();
  await expect(page.getByRole("dialog", { name: "Integration status" })).toHaveCount(0);
  if (info.project.name === "mobile") await trigger.tap();
  else await trigger.click();
  const popover = page.getByRole("dialog", { name: "Integration status" });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("not live results");
  await page.getByText("ForkSafe", { exact: true }).click();
  await expect(popover).toHaveCount(0);
});

test("running investigation can be cancelled with a visible pending phase", async ({ page }, info) => {
  await page.goto("/");
  if (info.project.name === "mobile") {
    const option = page.getByLabel("Switch investigation").locator("option").filter({ hasText: /fast transit/i });
    await page.getByLabel("Switch investigation").selectOption((await option.getAttribute("value"))!);
  } else {
    await page.getByRole("button", { name: /fast transit/ }).click();
  }
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("cancel-investigation").click();
  await expect(page.getByText("cancellation pending")).toBeVisible();
  await expect(page.getByTestId("investigation-view").getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("cancel-investigation")).toHaveCount(0);
});

test("restricted investigation shows a permission state", async ({ page }, info) => {
  await page.goto("/");
  if (info.project.name === "mobile") {
    const option = page.getByLabel("Switch investigation").locator("option").filter({ hasText: /restricted/i });
    await page.getByLabel("Switch investigation").selectOption((await option.getAttribute("value"))!);
  } else {
    await page.getByRole("button", { name: /Restricted/ }).click();
  }
  await expect(page.getByTestId("permission-state")).toContainText("Access denied");
});

test("readiness endpoint returns contract-shaped data without secret values", async ({ request }) => {
  const res = await request.get("/api/readiness");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.integrations.length).toBeGreaterThanOrEqual(10);
  for (const r of body.integrations) {
    expect(["live", "local", "fixture", "blocked", "not_implemented"]).toContain(r.mode);
    expect(typeof r.probed).toBe("boolean");
  }
});
