import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// The browser test of zeteo's admin UI, against the stack e2e/run.sh starts
// (`e2e/run.sh --browser` runs only this). It reads the same E2E_*
// environment as the Vitest files.
export default defineConfig({
  testDir: fileURLToPath(new URL("./browser", import.meta.url)),
  testMatch: "**/*.spec.ts",
  // Traces and screenshots of a failed run; git-ignored.
  outputDir: fileURLToPath(new URL("./browser-results", import.meta.url)),
  // One stack, one set of users: one test at a time, and a failure is real.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    // A loopback address is a secure context, which sign-in's PKCE needs.
    baseURL: process.env.E2E_ZETEO_URL,
    headless: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
