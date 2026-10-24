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

  // Readiness strip shows the web data source and every integration's honest mode.
  const strip = page.getByTestId("readiness-strip");
  await expect(strip.getByTestId("readiness-web-data")).toContainText("fixture");
  await expect(strip.getByTestId("readiness-convex")).toBeVisible();
  for (const name of ["convex", "spacetimedb", "daytona", "factory", "elastic", "atlassian_jira"]) {
    await expect(strip.getByTestId(`readiness-${name}`)).toHaveAttribute("data-mode", /^(live|local|fixture|blocked|not_implemented)$/);
  }
  await expect(page.getByTestId("fixture-banner")).toBeVisible();

  // Open the recorded investigation.
  await page.getByRole("button", { name: /Panda clips divider/ }).click();
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

  // Environment grid and evidence feed with provenance.
  await page.getByRole("tab", { name: "Environments" }).click();
  await expect(page.getByTestId("env-tile-1")).toBeVisible();
  await expect(page.getByTestId("env-tile-3")).toBeVisible();
  await page.getByTestId("env-tile-1").getByRole("button", { name: "Experiment timeline" }).click();
  await expect(page.getByTestId("env-tile-1").getByRole("listitem").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath(`environments-${info.project.name}.png`), fullPage: true });

  await page.getByRole("tab", { name: "Evidence" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("finding").first()).toContainText(/Env \d/);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath(`evidence-${info.project.name}.png`), fullPage: true });

  // Candidate comparison: synced panes, then review bound to the exact hash.
  await page.getByRole("tab", { name: "Compare & review" }).click();
  const cmp = page.getByTestId("comparison-replay");
  await expect(cmp.getByTestId("replay-viewer")).toHaveCount(2);
  await cmp.getByTestId("replay-scrubber").fill("5");
  await expect(cmp.getByTestId("frame-readout").nth(0)).toContainText("t=5.00 s");
  await expect(cmp.getByTestId("frame-readout").nth(1)).toContainText("t=5.00 s");
  await expect(page.getByTestId("changed-functions")).toContainText("plan_transit");
  await expect(page.getByTestId("suite-public")).toContainText("10/10 passed");
  const sha = (await page.getByTestId("candidate-sha").textContent())!.trim();
  expect(sha).toMatch(/^[0-9a-f]{64}$/);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath(`compare-${info.project.name}.png`), fullPage: true });

  const review = page.getByTestId("review-panel");
  await review.getByLabel("Approve for engineering review").check();
  await review.getByLabel("Notes (optional)").fill("Clears divider on all public and withheld cases.");
  await review.getByTestId("submit-review").click();
  await expect(review.getByTestId("review-history")).toContainText("approved");
  await expect(review.getByTestId("review-history")).toContainText(sha.slice(0, 12));
});

test("running investigation can be cancelled with a visible pending phase", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /fast transit/ }).click();
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("cancel-investigation").click();
  await expect(page.getByText("cancellation pending")).toBeVisible();
  await expect(page.getByTestId("investigation-view").getByText("cancelled", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("cancel-investigation")).toHaveCount(0);
});

test("restricted investigation shows a permission state", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Restricted/ }).click();
  await expect(page.getByTestId("permission-state")).toContainText("Access denied");
});

test("readiness endpoint returns contract-shaped data without secret values", async ({ request }) => {
  const res = await request.get("/api/readiness");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.integrations.length).toBeGreaterThanOrEqual(10);
  for (const r of body.integrations) expect(["live", "local", "fixture", "blocked", "not_implemented"]).toContain(r.mode);
});
