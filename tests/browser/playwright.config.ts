import { defineConfig, devices } from "../../apps/web/e2e/playwright";
import path from "node:path";

// Playwright loads this file as CommonJS, so __dirname is defined.
const webDir = path.resolve(__dirname, "../../apps/web");

export default defineConfig({
  testDir: ".",
  outputDir: "../../apps/web/test-results",
  reporter: [["list"], ["html", { outputFolder: "../../apps/web/playwright-report", open: "never" }]],
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: {
    command: "pnpm exec vite --port 5173 --strictPort --host 127.0.0.1",
    cwd: webDir,
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    // Fixture adapter for the browser story; live data replaces it after the integration checkpoint.
    env: { VITE_FORKSAFE_DATA: "fixture" },
    timeout: 60_000,
  },
});
