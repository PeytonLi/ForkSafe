import path from "node:path";
import { expect, test, type Page } from "../../apps/web/e2e/playwright";

const shots = "/home/ubuntu/lane-a/shots";
const pandaId = "3b7d9303-7082-4b73-a3b6-1391b3e2fc4d";

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page must not scroll horizontally").toBeLessThanOrEqual(0);
}

async function screenshot(page: Page, name: string, viewport: string) {
  await page.screenshot({ path: path.join(shots, `${name}-${viewport}.png`), animations: "disabled" });
}

test("scene capture journey, fixture limits, and scenario reset", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const viewport = mobile ? "390x844" : "1440x900";
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Let’s work out what went wrong." })).toBeVisible();
  await screenshot(page, "overview", viewport);

  if (mobile) {
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Menu" });
    await expect(drawer.getByRole("link", { name: "New simulation" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await page.getByRole("main").getByRole("link", { name: "New simulation", exact: true }).click();
  } else {
    const sidebar = page.getByRole("navigation", { name: "Main" });
    const collapse = page.getByRole("button", { name: "Collapse sidebar" });
    await collapse.click();
    const newSimulation = sidebar.getByRole("link", { name: "New simulation" });
    await expect(newSimulation).toHaveAttribute("title", "New simulation");
    await newSimulation.hover();
    await expect(page.getByText("New simulation", { exact: true }).last()).toBeVisible();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await sidebar.getByRole("link", { name: "New simulation" }).click();
  }

  const journey = page.getByTestId("new-simulation");
  await expect(journey.getByRole("heading", { name: "Pick a task" })).toBeVisible();
  await screenshot(page, "new-step1", viewport);
  await journey.getByRole("radio", { name: /Push through a gap/ }).check();
  await journey.getByRole("button", { name: "Next" }).click();
  await expect(journey.getByRole("heading", { name: "Set up the scene" })).toBeVisible();
  await expect(journey.getByTestId("scene-preview")).toHaveAttribute("data-scene-kind", "push_through_gap");
  await screenshot(page, "new-step2", viewport);

  const gapWidth = journey.getByLabel("Gap width value");
  await gapWidth.fill("0.09");
  await gapWidth.press("Tab");
  await expect(journey.getByTestId("scene-preview-summary")).toHaveText("Gap width: 0.09 m");
  await journey.getByTestId("scene-preview").scrollIntoViewIfNeeded();
  await screenshot(page, "push-gap-preview", viewport);
  await expectNoHorizontalOverflow(page);

  await journey.getByRole("button", { name: "Find a failure for me" }).click();
  const searchMessage = journey.getByTestId("find-failure-result");
  await expect(searchMessage).toContainText("Fixture mode cannot search for a failure");
  await searchMessage.scrollIntoViewIfNeeded();
  await screenshot(page, "fixture-find-failure", viewport);
  await expectNoHorizontalOverflow(page);

  await journey.getByRole("button", { name: "Next" }).click();
  await expect(journey.getByRole("heading", { name: "Agents" })).toBeVisible();
  await screenshot(page, "new-step3", viewport);
  await journey.getByRole("button", { name: "Start" }).click();
  const refusal = journey.getByTestId("start-refusal");
  await expect(refusal).toContainText("Fixture mode cannot run physics");
  await refusal.scrollIntoViewIfNeeded();
  await screenshot(page, "fixture-refusal", viewport);

  await page.goto(`/#/investigations/${pandaId}/capture`);
  await expect(page.getByTestId("capture-progress")).toBeVisible();
  await screenshot(page, "capture-progress", viewport);
  const capturedFailure = page.getByRole("region", { name: "Captured failure" });
  await capturedFailure.getByTestId("open-scenario").click();
  const editor = page.getByRole("dialog", { name: "Edit scenario" });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("This recorded example uses an older scene format");
  const dividerHeight = editor.getByLabel("Divider height value");
  await dividerHeight.fill("0.20");
  await dividerHeight.press("Tab");
  await expect(editor.getByTestId("scene-preview-summary")).toHaveText("Divider height: 0.20 m");
  await editor.scrollIntoViewIfNeeded();
  await screenshot(page, "edit-scenario", viewport);
  await editor.getByRole("button", { name: "Reset" }).click();
  await expect(editor.getByTestId("scene-preview-summary")).toHaveText("Divider height: 0.10 m");
  await expectNoHorizontalOverflow(page);
});
