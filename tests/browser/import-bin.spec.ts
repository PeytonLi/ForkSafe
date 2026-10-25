import path from "node:path";
import { expect, test } from "../../apps/web/e2e/playwright";

const EXAMPLE = path.resolve(__dirname, "../../examples/bin-drop");

test("an uploaded bin drop is accepted and is not a stock new-simulation task", async ({ page }) => {
  await page.goto("/#/new");
  await expect(page.getByRole("radio", { name: /Drop into an open bin/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Pick and place over a divider/ })).toBeChecked();

  await page.getByLabel("Scene JSON").setInputFiles(path.join(EXAMPLE, "scene.json"));
  await page.getByLabel("Controller Python").setInputFiles(path.join(EXAMPLE, "task_controller.py"));
  await page.getByRole("button", { name: "Use these files" }).click();
  await expect(page.getByTestId("import-failure")).toContainText("Imported controller will be the one that runs");

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("scene-preview")).toHaveAttribute("data-scene-kind", "bin_drop");
  await expect(page.getByTestId("scene-preview-summary")).toContainText("Bin opening: 0.12 m");
  await expect(page.getByLabel("Bin opening value")).toHaveValue("0.12");

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByLabel("Investigation name")).toHaveValue("Cube released beside the open bin");
  await page.getByRole("group", { name: "Environment count" }).getByRole("button", { name: "3", exact: true }).click();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("start-refusal")).toContainText("can't record a new robot run");
});
