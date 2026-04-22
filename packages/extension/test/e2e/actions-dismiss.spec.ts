/**
 * CP06 E2E: 👎 dismiss action.
 *
 * Asserts:
 *   - Clicking 👎 fires POST /candidates/:id/action with action="dismissed".
 *   - The Dock unmounts from the DOM (`#twh-dock` disappears).
 *   - Zero console errors.
 *
 * Scope: dismiss-only. Regen, fill, and stub behaviours live in their
 * own spec files. We run in fullyParallel: false (see playwright.config)
 * so tearing down + re-seeding between specs is not necessary — each
 * test boots its own env via startCP06Env().
 */
import { expect, test } from "@playwright/test";
import { startCP06Env, type CP06Env } from "./helpers/actions-env.js";

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

test("click 👎 → POST action=dismissed, Dock unmounts", async () => {
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

  await page.locator('[data-testid="twh-dismiss"]').click();

  // Dock must unmount.
  await expect(dock).toHaveCount(0, { timeout: 2_000 });

  // POST must have fired.
  await page.waitForTimeout(200);
  expect(actionPosts.length).toBe(1);
  const post = actionPosts[0]!;
  expect(post.method).toBe("POST");
  expect(post.url).toMatch(/\/candidates\/20\/action$/);
  expect(JSON.parse(post.body ?? "{}")).toEqual({ action: "dismissed" });

  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});
