/**
 * CP06 E2E: 🔄 regen action.
 *
 * Asserts:
 *   - Clicking 🔄 fires POST /candidates/:id/action with
 *     action="regen_requested".
 *   - An in-page toast becomes visible and stays visible for ≥ 2 s.
 *   - The Dock remains mounted (regen does NOT dismiss).
 *   - Zero console errors.
 *
 * The toast's dismissal is timer-driven (2500 ms in the implementation).
 * We wait past the 2 s threshold and re-assert visibility to satisfy the
 * "visible for ≥ 2 s" clause, then confirm the Dock is still there.
 */
import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { EVIDENCE_DIR, startCP06Env, type CP06Env } from "./helpers/actions-env.js";

let env: CP06Env;

interface ActionPost {
  url: string;
  method: string;
  body: string | null;
}

test.beforeAll(async () => {
  env = await startCP06Env();
});

test.afterAll(async () => {
  await env?.teardown();
});

test("click 🔄 → POST action=regen_requested, toast ≥ 2s, Dock stays", async () => {
  const page = await env.ext.context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  const actionPosts: ActionPost[] = [];
  await page.route("**/candidates/**/action", async (route) => {
    const req = route.request();
    actionPosts.push({
      url: req.url(),
      method: req.method(),
      body: req.postData(),
    });
    await route.continue();
  });

  await page.goto(`${env.fixtureBase}/jack/status/20`);
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg.text().includes("[twitter-helper] suggestion available for 20"),
    timeout: 5_000,
  });

  const dock = page.locator("#twh-dock");
  await expect(dock).toBeVisible({ timeout: 5_000 });

  const tStart = Date.now();
  await page.locator('[data-testid="twh-regen"]').click();

  const toast = page.locator('[data-testid="twh-toast"]');
  await expect(toast).toBeVisible({ timeout: 2_000 });

  // Screenshot with the toast visible, before it auto-dismisses.
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "toast-regen.png"),
    fullPage: true,
  });

  // Verify POST went out.
  await page.waitForTimeout(200);
  expect(actionPosts.length).toBe(1);
  const post = actionPosts[0]!;
  expect(post.method).toBe("POST");
  expect(post.url).toMatch(/\/candidates\/20\/action$/);
  expect(JSON.parse(post.body ?? "{}")).toEqual({ action: "regen_requested" });

  // Toast must remain visible for ≥ 2 s from click. Sleep the remainder
  // of that window, then re-assert visibility.
  const elapsed = Date.now() - tStart;
  const remainingTo2s = Math.max(0, 2_000 - elapsed);
  if (remainingTo2s > 0) await page.waitForTimeout(remainingTo2s);
  await expect(toast).toBeVisible();

  // Dock must STILL be mounted.
  await expect(dock).toBeVisible();

  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});
