import path from "node:path";
import { expect, test, type Page, type TestInfo } from "../../apps/web/e2e/playwright";

const INVESTIGATION_ID = "3b7d9303-7082-4b73-a3b6-1391b3e2fc4d";
test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

async function openDemo(page: Page, mobile: boolean, fixtureStream: boolean) {
  await page.goto(fixtureStream ? "/?fixtureStream=1" : "/");
  await page.addStyleTag({ content: "html{scrollbar-width:none}" });
  if (mobile) {
    await page.getByLabel("Switch investigation").selectOption(INVESTIGATION_ID);
  } else {
    await page.getByRole("button", { name: /Panda clips divider/ }).click();
  }
  await expect(page.getByTestId("investigation-title")).toContainText("Panda clips divider");
}

function evidencePath(info: TestInfo, name: string) {
  return process.env.LANE_E_ARTIFACTS
    ? path.join(process.env.LANE_E_ARTIFACTS, name)
    : info.outputPath(name);
}

async function openEnvironments(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("combobox", { name: "Investigation sections" }).selectOption("environments");
  } else {
    await page.getByRole("tab", { name: "Environments" }).click();
  }
}

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test("fixture live stream advances, hands off to replay, and appears in environment cards", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await openDemo(page, mobile, true);
  const capture = page.getByTestId("baseline-replay");
  const viewer = capture.getByTestId("live-viewer");
  const capturedFailure = page.getByRole("region", { name: "Captured failure" });
  await expect(viewer).toHaveAttribute("data-state", "waiting");
  await expect(viewer.getByText("Waiting for sandbox", { exact: true })).toBeVisible();
  await expect(capturedFailure.getByText("Running", { exact: true })).toBeVisible();
  await expect(capturedFailure.getByText("Not known yet", { exact: true })).toBeVisible();
  await expect(capturedFailure.getByText(/forbidden contact/i)).toHaveCount(0);
  await expect(viewer).toHaveAttribute("data-state", "streaming", { timeout: 10_000 });
  await expect(viewer.getByText("Fixture stream", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(viewer.getByText("Live", { exact: true })).toHaveCount(0);
  if (mobile) await page.screenshot({ path: evidencePath(info, "phone-capture-streaming.png") });
  const readout = viewer.getByTestId("frame-readout");
  const initialText = await readout.textContent();
  const initialT = Number(/t=([0-9.]+)/.exec(initialText ?? "")?.[1] ?? 0);
  await expect.poll(async () => {
    const text = await readout.textContent();
    return Number(/t=([0-9.]+)/.exec(text ?? "")?.[1] ?? 0);
  }, { timeout: 5_000 }).toBeGreaterThan(initialT + 0.1);
  if (!mobile) await page.screenshot({ path: evidencePath(info, "capture-streaming-desktop.png") });

  await page.waitForTimeout(7_500);
  const scrubber = capture.getByTestId("replay-scrubber");
  await expect(scrubber).toBeVisible({ timeout: 20_000 });
  await expect(capturedFailure.getByText(/forbidden contact/i)).toBeVisible();
  if (!mobile) await page.screenshot({ path: evidencePath(info, "capture-after-handoff-desktop.png") });

  await openEnvironments(page, mobile);
  const environmentGrid = page.getByTestId("environment-grid");
  await expect(environmentGrid).toBeVisible();
  const firstEnvironment = page.getByTestId("env-tile-1");
  await expect(firstEnvironment.getByText("Active", { exact: true })).toBeVisible();
  await expect(firstEnvironment.getByText("1 active / 2", { exact: true })).toBeVisible();
  if (mobile) {
    const switcher = environmentGrid.getByRole("tablist", { name: "Live environments" });
    await expect(switcher.getByRole("tab")).toHaveCount(3);
    await expect(firstEnvironment.getByTestId("live-viewer")).toHaveAttribute("data-state", "streaming", { timeout: 10_000 });
    await expect(firstEnvironment.getByTestId("live-viewer").getByText("Fixture stream", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(firstEnvironment.getByTestId("live-viewer").locator("[data-label]")).toHaveAttribute("data-label", /.+/);
    await expect(firstEnvironment.getByTestId("live-viewer").locator("[data-label]")).not.toHaveAttribute("data-label", "Env 1");
    for (const index of [2, 3]) {
      await expect(page.getByTestId(`env-tile-${index}`).getByRole("button", { name: "Watch live" })).toBeVisible();
      await expect(page.getByTestId(`env-tile-${index}`).getByTestId("live-viewer")).toHaveCount(0);
    }
    await page.screenshot({ path: evidencePath(info, "phone-environments-live.png") });
    const secondEnvironment = page.getByTestId("env-tile-2");
    await secondEnvironment.getByRole("button", { name: "Watch live" }).click();
    await expect(switcher.getByRole("tab", { name: "Env 2" })).toHaveAttribute("aria-selected", "true");
    await expect(secondEnvironment.getByTestId("live-viewer")).toHaveAttribute("data-state", "streaming", { timeout: 10_000 });
    await expect(secondEnvironment.getByTestId("live-viewer").getByText("Fixture stream", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(firstEnvironment.getByRole("button", { name: "Watch live" })).toBeVisible();
    await page.screenshot({ path: evidencePath(info, "phone-environments-watch-live.png") });
    await switcher.getByRole("tab", { name: "Env 3" }).click();
    await expect(page.getByTestId("env-tile-3").getByTestId("live-viewer")).toHaveCount(1);
    await expect(secondEnvironment.getByRole("button", { name: "Watch live" })).toBeVisible();
    await expect(firstEnvironment.getByTestId("live-viewer")).toHaveCount(0);
  } else {
    for (const index of [1, 2, 3]) {
      const tile = page.getByTestId(`env-tile-${index}`);
      const environmentViewer = tile.getByTestId("live-viewer");
      await expect(environmentViewer).toHaveAttribute("data-state", "streaming", { timeout: 10_000 });
      await expect(environmentViewer.getByText("Fixture stream", { exact: true })).toBeVisible({ timeout: 10_000 });
      const canvasCaption = environmentViewer.locator("[data-label]");
      await expect(canvasCaption).toHaveAttribute("data-label", /.+/);
      expect(await canvasCaption.getAttribute("data-label")).not.toBe(`Env ${index}`);
    }
    await page.screenshot({ path: evidencePath(info, "environments-live-desktop.png") });
  }
  const visibleViewers = await environmentGrid.getByTestId("live-viewer").evaluateAll((viewers) =>
    viewers.filter((viewer) => {
      const rect = viewer.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > 0;
    }).length,
  );
  expect(await environmentGrid.locator("canvas").count()).toBeLessThanOrEqual(visibleViewers);
  await assertNoOverflow(page);
});

test("fixture mode without opt-in keeps the normal baseline replay", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await openDemo(page, mobile, false);
  const capture = page.getByTestId("baseline-replay");
  await expect(capture.getByTestId("live-viewer")).toHaveCount(0);
  await expect(capture.getByTestId("replay-scrubber")).toBeVisible();
});
