import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the extension E2E suite.
 *
 * The E2E test drives a real Chromium persistent context with the
 * unpacked extension loaded via `--load-extension` (see test/e2e helpers).
 * We skip the `projects[0].use.browser` indirection because we launch
 * the browser manually with an extension-aware `persistentContext`.
 */
export default defineConfig({
  testDir: "test/e2e",
  timeout: 120_000, // generous — we test a 35s service-worker idle path
  fullyParallel: false, // shares a real daemon + a persistent context
  workers: 1,
  forbidOnly: true,
  reporter: [["list"]],
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
