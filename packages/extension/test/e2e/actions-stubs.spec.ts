/**
 * CP06 E2E: 💬 quote and 🔖 save stubs.
 *
 * Asserts:
 *   - Clicking 💬 shows a toast reading "Coming in Phase 2".
 *   - Clicking 🔖 shows the same toast.
 *   - Neither click fires any /candidates/**\/action network request
 *     (verified via a Playwright route counter).
 *   - Zero console errors.
 *
 * The spec explicitly scopes these icons to Phase 2. A hard "no network"
 * assertion protects against accidental wiring — easy regression to
 * miss otherwise.
 */
import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { EVIDENCE_DIR, startCP06Env, type CP06Env } from "./helpers/actions-env.js";

let env: CP06Env;

test.beforeAll(async () => {
  env = await startCP06Env();
});

test.afterAll(async () => {
  await env?.teardown();
});

test("click 💬 and 🔖 → 'Coming in Phase 2' toast, no network", async () => {
  const page = await env.ext.context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  let actionCallCount = 0;
  await page.route("**/candidates/**/action", async (route) => {
    actionCallCount += 1;
    // Fulfil with 500 to surface any unwanted call loudly.
    await route.fulfill({ status: 500, body: "unexpected-call" });
  });

  await page.goto(`${env.fixtureBase}/jack/status/20`);
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg.text().includes("[twitter-helper] suggestion available for 20"),
    timeout: 5_000,
  });

  await expect(page.locator("#twh-dock")).toBeVisible({ timeout: 5_000 });

  // Click quote (💬).
  await page.locator('[data-testid="twh-quote"]').click();
  const toast = page.locator('[data-testid="twh-toast"]');
  await expect(toast).toBeVisible({ timeout: 2_000 });
  await expect(toast).toContainText("Coming in Phase 2");

  // Screenshot evidence for the stub toast.
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "toast-stub.png"),
    fullPage: true,
  });

  // Wait out the quote toast then click save (🔖). Single-slot toast:
  // the newer toast replaces the older, and we assert the same text.
  await page.waitForTimeout(100);
  await page.locator('[data-testid="twh-save"]').click();
  await expect(toast).toBeVisible({ timeout: 2_000 });
  await expect(toast).toContainText("Coming in Phase 2");

  // Drain any async fetch attempt that the production code might fire.
  await page.waitForTimeout(200);

  // Hard requirement: zero network calls on either stub button.
  expect(
    actionCallCount,
    `expected zero /candidates/**/action calls on stub clicks, got ${actionCallCount}`,
  ).toBe(0);

  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});
