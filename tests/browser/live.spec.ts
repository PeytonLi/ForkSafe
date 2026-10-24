import path from "node:path";
import { expect, test, type Page, type TestInfo } from "../../apps/web/e2e/playwright";

const INVESTIGATION_ID = "3b7d9303-7082-4b73-a3b6-1391b3e2fc4d";
test.use({ video: "on" });

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

test("fixture live stream advances, hands off to replay, and appears in the environment wall", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await openDemo(page, mobile, true);
  const capture = page.getByTestId("baseline-replay");
  const viewer = capture.getByTestId("live-viewer");
  await expect(viewer).toHaveAttribute("data-state", "waiting");
  await expect(viewer).toHaveAttribute("data-state", "streaming", { timeout: 10_000 });
  await expect(viewer.getByText("Fixture stream", { exact: true })).toBeVisible();
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
  if (!mobile) await page.screenshot({ path: evidencePath(info, "capture-after-handoff-desktop.png") });

  await openEnvironments(page, mobile);
  const wall = page.getByTestId("live-wall");
  await expect(wall).toBeVisible();
  const firstEnvironment = page.getByTestId("env-tile-1");
  await expect(firstEnvironment.getByText("Active", { exact: true })).toBeVisible();
  await expect(firstEnvironment.getByText("1 active / 2", { exact: true })).toBeVisible();
  if (mobile) {
    const switcher = wall.getByRole("tablist", { name: "Live environments" });
    await expect(switcher.getByRole("tab")).toHaveCount(3);
    await expect(wall.getByTestId("live-viewer")).toHaveAttribute("data-state", "streaming", { timeout: 5_000 });
    await expect(wall.getByTestId("live-viewer").locator('[data-label="Env 1"]')).toBeVisible();
    await switcher.getByRole("tab", { name: "Env 2" }).click();
    await expect(wall.getByTestId("live-viewer").locator('[data-label="Env 2"]')).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: evidencePath(info, "phone-live-switcher.png") });
  } else {
    await expect(wall.getByTestId("live-viewer").first()).toHaveAttribute("data-state", "streaming", { timeout: 10_000 });
    await page.screenshot({ path: evidencePath(info, "environments-live-wall-desktop.png") });
  }
  await page.waitForTimeout(5_000);
  const viewers = await wall.getByTestId("live-viewer").count();
  expect(await wall.locator("canvas").count()).toBeLessThanOrEqual(viewers);
  await assertNoOverflow(page);
});

test("fixture mode without opt-in keeps the normal baseline replay", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await openDemo(page, mobile, false);
  const capture = page.getByTestId("baseline-replay");
  await expect(capture.getByTestId("live-viewer")).toHaveCount(0);
  await expect(capture.getByTestId("replay-scrubber")).toBeVisible();
});
