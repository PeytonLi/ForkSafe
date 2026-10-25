import { expect, test } from "../../apps/web/e2e/playwright";

const PANDA = "3b7d9303-7082-4b73-a3b6-1391b3e2fc4d";

test("scene prompt, shrink, reviewer seat, case file, and challenge stay in the product", async ({ page }) => {
  await page.goto("/#/new");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Describe a scene change").fill("Move the divider 6 cm closer");
  await page.getByRole("button", { name: "Apply to the sliders" }).click();
  await expect(page.getByTestId("scene-prompt-result")).toContainText("-0.060 m");

  await page.getByLabel("Describe a scene change").fill("Add a second arm");
  await page.getByRole("button", { name: "Apply to the sliders" }).click();
  await expect(page.getByTestId("scene-prompt-result")).toContainText("cannot represent");
  await expect(page.getByRole("slider", { name: /divider away from robot/i })).toHaveValue("-0.06");

  await page.getByRole("button", { name: "Shrink this failure" }).click();
  await expect(page.getByText("not a new MuJoCo run")).toBeVisible();

  await page.getByRole("radio", { name: "Reviewer" }).check();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("This seat cannot start a simulation.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start" })).toBeDisabled();

  await page.getByRole("radio", { name: "Lead" }).check();
  await expect(page.getByRole("button", { name: "Start" })).toBeEnabled();

  await page.goto(`/#/investigations/${PANDA}/casefile`);
  await expect(page.getByTestId("case-file")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What this result does not prove" })).toBeVisible();
  await expect(page.getByTestId("case-file")).toContainText("does not merge code");

  await page.goto(`/#/investigations/${PANDA}/compare`);
  const challenge = page.getByTestId("challenge-case").first();
  await expect(challenge).toBeVisible();
  await challenge.getByLabel("Note").fill("Raise the divider after the recorded pass");
  await challenge.getByRole("button", { name: "Ask for this case" }).click();
  await expect(challenge).toContainText("Waiting for a physics run");
  await expect(challenge).not.toContainText("Passed");

  await page.goto(`/#/investigations/${PANDA}/casefile`);
  await expect(page.getByTestId("case-file")).toContainText("Raise the divider after the recorded pass");
  await expect(page.getByText("Waiting for physics")).toBeVisible();

  await page.goto(`/#/investigations/${PANDA}/environments`);
  const hypothesis = page.getByRole("textbox", { name: "Hypothesis" }).first();
  await hypothesis.fill("The approach is too fast");
  await hypothesis.locator("xpath=ancestor::form").getByRole("button", { name: "Save hypothesis" }).click();
  await expect(page.getByTestId("saved-hypothesis").first()).toHaveText("The approach is too fast");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Hypothesis" }).first()).toHaveValue("The approach is too fast");
});
