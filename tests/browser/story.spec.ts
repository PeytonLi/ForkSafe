import { expect, test, type Page, type TestInfo } from "../../apps/web/e2e/playwright";

function learningScreenshotPath(info: TestInfo, name: string): string {
  return process.env.CI ? info.outputPath(name) : `/home/ubuntu/lane-d/shots/${name}`;
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page must not scroll horizontally").toBeLessThanOrEqual(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test("browser story: readiness, fixture investigation, replay scrub, review", async ({ page }, info) => {
  if (info.project.name === "desktop") test.setTimeout(90_000);
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
  await expect(scrubber).toBeVisible({ timeout: 10_000 });
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
  await expect(cmp.getByTestId("replay-viewer")).toHaveCount(2, { timeout: 15_000 });
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

const PANDA = "3b7d9303-7082-4b73-a3b6-1391b3e2fc4d";

async function openSection(page: Page, mobile: boolean, value: string, label: string) {
  if (mobile) await page.getByRole("combobox", { name: "Investigation sections" }).selectOption(value);
  else await page.getByRole("tab", { name: label }).click();
}

test("health page: plain-language service cards and pipeline counts", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await page.goto("/");
  await page.getByTestId("readiness-strip").getByRole("button").first().click();
  await page.getByTestId("readiness-see-all").click();
  await expect(page).toHaveURL(/#\/health$/);
  const health = page.getByTestId("health-page");
  await expect(health.getByRole("heading", { name: "How everything is running" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Integration status" })).toHaveCount(0);

  const readiness = (await (await page.request.get("/api/readiness")).json()).integrations as { name: string; mode: string; probed: boolean }[];
  for (const r of readiness) {
    const card = health.getByTestId(`health-${r.name}`);
    const label = r.mode === "blocked" ? "Blocked" : r.mode === "not_implemented" ? "Not implemented" : r.mode === "fixture" ? "Fixture" : r.probed ? "Live" : "Configured";
    await expect(card.getByText(label, { exact: true })).toBeVisible();
  }
  const daytona = health.getByTestId("health-daytona");
  if (mobile) {
    const toggle = daytona.getByRole("button", { name: /Daytona/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
  await expect(daytona).toContainText(/experiments|sandboxes/);
  await expect(daytona.getByText(/^Checked /)).toBeVisible();

  const pipeline = page.getByTestId("pipeline-card");
  await expect(pipeline.getByText("Fixture", { exact: true })).toBeVisible();
  await expect(pipeline.getByTestId("pipeline-sandboxes")).toContainText("of 5");
  await expect(pipeline.getByTestId("pipeline-dead")).toHaveText("0");

  // Keyboard: filter to services that need attention.
  const attention = health.getByRole("button", { name: /Needs attention/ });
  await attention.focus();
  await page.keyboard.press("Enter");
  await expect(attention).toHaveAttribute("aria-pressed", "true");
  const attentionCount = readiness.filter((r) => ["blocked", "not_implemented", "fixture"].includes(r.mode)).length;
  await expect(health.getByRole("list", { name: "Services" }).getByRole("listitem")).toHaveCount(attentionCount);
  await expectNoHorizontalOverflow(page);
});

test("why did this fail: cited fixture answer, withheld source, not-enough and out-of-scope states", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await page.goto(`/#/investigations/${PANDA}/ask`);
  const ask = page.getByTestId("ask-panel");
  await expect(ask.getByRole("heading", { name: "Why did this fail?" })).toBeVisible();
  await expect(ask.getByRole("group", { name: "Suggested questions" }).getByRole("button")).toHaveCount(3);

  // Keyboard path: type and press Enter.
  await ask.getByTestId("ask-input").focus();
  await page.keyboard.type("Why did the cube hit the divider?");
  await page.keyboard.press("Enter");
  const answer = ask.getByTestId("ask-answer");
  await expect(answer).toContainText("first penetration at t=4.1 s");
  await expect(answer).toContainText("Elastic evidence agent was not used");
  await expect(answer.getByText("Fixture", { exact: true })).toBeVisible();
  const withheld = answer.getByTestId("citation-withheld");
  await expect(withheld).toHaveCount(1);
  await expect(withheld.locator("s")).toBeVisible();
  await expect(answer.getByTestId("withheld-note")).toContainText("was revoked");
  await expectNoHorizontalOverflow(page);

  // A citation chip opens the exact evidence row.
  const chip = answer.getByTestId("citation-chip").first();
  const href = (await chip.getAttribute("href"))!;
  const findingId = href.split("/").pop()!;
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/evidence/${findingId}$`));
  const row = page.locator(`[data-finding-id="${findingId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();

  // Not enough evidence is a friendly state, never a guess.
  await page.goto(`/#/investigations/${PANDA}/ask`);
  await page.getByTestId("ask-input").fill("What is the weather on Mars today?");
  await page.getByTestId("ask-submit").click();
  const soft = page.getByTestId("ask-not-enough");
  await expect(soft).toContainText("We don't have enough evidence to answer that yet");
  await expect(soft.getByTestId("citation-chip")).toHaveCount(0);

  // Questions about other investigations are refused before anything is asked.
  await page.getByTestId("ask-input").fill("Compare this with all investigations");
  await page.getByTestId("ask-submit").click();
  await expect(page.getByTestId("ask-error")).toContainText("only be about this investigation");
  await expectNoHorizontalOverflow(page);
});

test("learning loop: approved lineage and fixture retry at desktop and mobile sizes", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const size = mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  await page.setViewportSize(size);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.addStyleTag({ content: "html{scrollbar-width:none} *,*::before,*::after{animation-duration:0.01ms!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}" });
  if (mobile) await page.getByLabel("Switch investigation").selectOption(PANDA);
  else await page.getByRole("button", { name: /Panda clips divider/ }).click();

  await openSection(page, mobile, "learning", "What we learned");
  const learning = page.getByTestId("learning-panel");
  await expect(learning.getByTestId("controller-lineage")).toContainText("Baseline v1");
  await expect(learning.getByTestId("retry-unavailable")).toContainText("No fix has been approved");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: learningScreenshotPath(info, `learning-before-approval-${info.project.name}.png`) });

  await openSection(page, mobile, "compare", "Compare & review");
  const subtabs = page.getByTestId("compare-subtabs");
  await subtabs.getByRole("tab", { name: "Review" }).click();
  const review = page.getByTestId("review-panel");
  await review.getByLabel("Approve for engineering review").check();
  await review.getByTestId("submit-review").click();
  await expect(review.getByTestId("review-history")).toContainText("Approved");

  await openSection(page, mobile, "learning", "What we learned");
  await expect(learning.getByTestId("controller-lineage")).toContainText("Fix approved in Panda clips");
  await expect(learning.getByTestId("controller-lineage")).toContainText("v2");
  await expect(learning.getByTestId("retry-improved")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: learningScreenshotPath(info, `learning-after-approval-${info.project.name}.png`) });

  await learning.getByTestId("retry-improved").click();
  await expect(learning.getByText("Recorded fixture, not a live rerun")).toBeVisible();
  await expect(learning.getByTestId("retry-outcome")).toContainText("Before: hit the divider at 4.1 s. After: placed the cube in 7.1 s.");
  await expect(learning.getByTestId("replay-viewer")).toHaveCount(2);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: learningScreenshotPath(info, `learning-after-retry-${info.project.name}.png`) });
});

test("compare: original run as a time-synced ghost with legend and toggle", async ({ page }, info) => {
  await page.goto(`/#/investigations/${PANDA}/capture`);
  await openSection(page, info.project.name === "mobile", "compare", "Compare & review");
  const cmp = page.getByTestId("comparison-replay");
  const repaired = cmp.locator('[data-testid="replay-viewer"][data-label="Repaired candidate"]');
  const original = cmp.locator('[data-testid="replay-viewer"][data-label="Original"]');
  const toggle = page.getByTestId("ghost-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ghost-legend")).toContainText("Original arm (ghost)");
  await expect(repaired).toHaveAttribute("data-ghost", "on");
  await expect(original).toHaveAttribute("data-ghost", "off");

  await cmp.getByTestId("replay-scrubber").fill("4.1");
  await expect(repaired).toHaveAttribute("data-ghost-t", "4.10");
  await expect(original.getByTestId("frame-readout")).toContainText("t=4.10 s");
  await cmp.getByTestId("replay-scrubber").focus();
  await page.keyboard.press("ArrowRight");
  await expect(repaired).toHaveAttribute("data-ghost-t", "4.20");
  await expect(repaired.getByTestId("frame-readout")).toContainText("t=4.20 s");
  await expectNoHorizontalOverflow(page);

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(repaired).toHaveAttribute("data-ghost", "off");
  await expect(page.getByTestId("ghost-legend")).toHaveCount(0);
});

test("timeline: swim lanes on desktop, vertical list on phones", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await page.goto(`/#/investigations/${PANDA}/capture`);
  await openSection(page, mobile, "timeline", "Timeline");
  const timeline = page.getByTestId("timeline");
  if (mobile) {
    await expect(timeline.getByTestId("timeline-chart")).toHaveCount(0);
    const list = timeline.getByTestId("timeline-list");
    await expect(list.getByRole("listitem").first()).toBeVisible();
    await list.getByRole("button", { name: "Env 2" }).tap();
    await expect(list.getByRole("button", { name: "Env 2" })).toHaveAttribute("aria-pressed", "true");
    await expect(list).toContainText("Experiment");
    const more = list.getByTestId("timeline-more");
    if (await more.count()) {
      const before = await list.getByRole("listitem").count();
      await more.tap();
      expect(await list.getByRole("listitem").count()).toBeGreaterThan(before);
    }
  } else {
    const chart = timeline.getByTestId("timeline-chart");
    for (const n of [1, 2, 3]) await expect(chart.getByTestId(`timeline-lane-${n}`)).toBeVisible();
    const readout = chart.getByTestId("timeline-readout");
    const first = chart.getByRole("toolbar").getByRole("button").first();
    await first.focus();
    const start = await readout.textContent();
    await page.keyboard.press("ArrowRight");
    await expect(readout).not.toHaveText(start!);
    await page.keyboard.press("End");
    await expect(readout).toContainText(/check|Fix|Experiment|job|session/i);
    // Only one tab stop inside the chart (roving focus).
    await expect(chart.locator('button[tabindex="0"]')).toHaveCount(1);
  }
  await expectNoHorizontalOverflow(page);
});

test("evidence: finding-influence graph shows cross-environment use", async ({ page }, info) => {
  await page.goto(`/#/investigations/${PANDA}/capture`);
  await openSection(page, info.project.name === "mobile", "evidence", "Evidence");
  await page.getByTestId("influence-toggle").click();
  const graph = page.getByTestId("influence-graph");
  await expect(graph.getByTestId("influence-edge")).toHaveCount(4);
  await expect(graph.locator('[data-testid="influence-edge"][data-cross="true"]')).toHaveCount(1);
  await expect(graph).toContainText("1 of 4 links crossed environments");
  const node = graph.getByRole("button", { name: /Finding 63a91fbd from Env 3/ });
  await node.focus();
  await expect(node).toBeFocused();
  await expectNoHorizontalOverflow(page);
});
