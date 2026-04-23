/**
 * CP06 E2E: ✍️ fill action.
 *
 * Asserts:
 *   - Clicking ✍️ dispatches a React-compatible insertion into the
 *     `data-testid="tweetTextarea_0"` contenteditable (verified by the
 *     fixture's simulated Tweet button flipping from disabled → enabled).
 *   - Composer text matches the seeded `suggested_reply`.
 *   - A POST `/candidates/:id/action` fires with body `{ action: "filled" }`.
 *   - Zero console errors throughout the flow.
 *
 * Why check the Tweet button? The fixture's submit button listens for
 * `input` events on the composer. If we mutated `.textContent` directly
 * the button stays disabled — that would mirror React's stale-state bug
 * on real twitter.com. The "enabled after fill" assertion is the spec's
 * explicit follow-up check for the React-sync contract.
 */
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
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

test("click ✍️ → composer filled, Tweet button enabled, POST action=filled", async () => {
  const page = await env.ext.context.newPage();

  const consoleMessages: string[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleMessages.push(line);
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(err.message);
    consoleMessages.push(`[pageerror] ${err.message}`);
  });

  // Intercept the action POST so we can assert the body shape even if
  // the daemon's real response would 200 it. We still let the request
  // through so the daemon's side-effect fires; we just snapshot the
  // request for the assertion.
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

  // Pre-click sanity: composer empty, tweet button disabled.
  const composer = page.locator('[data-testid="tweetTextarea_0"]');
  const tweetBtn = page.locator('[data-testid="tweetButtonInline"]');
  await expect(composer).toHaveText("");
  await expect(tweetBtn).toBeDisabled();

  // --- Click ✍️ -----------------------------------------------------------
  await page.locator('[data-testid="twh-fill"]').click();

  // Composer must contain the seeded suggested_reply.
  await expect(composer).toHaveText("Hi Jack, great first tweet.", {
    timeout: 5_000,
  });
  // Tweet button flips on via the fixture's `input` listener — the
  // canary for React-compatible insertion.
  await expect(tweetBtn).toBeEnabled({ timeout: 5_000 });

  // Composer must NOT be submitted: the Tweet button is only ENABLED,
  // the form isn't actually posted. We assert the composer still has
  // text (a submit would typically clear it) and no pageerror occurred.
  await expect(composer).toHaveText("Hi Jack, great first tweet.");

  // POST /candidates/:id/action must have fired once with filled.
  // Let async microtasks drain so the fetch completes.
  await page.waitForTimeout(200);
  expect(actionPosts.length, `expected 1 action POST, got ${actionPosts.length}`).toBe(
    1,
  );
  const post = actionPosts[0]!;
  expect(post.method).toBe("POST");
  expect(post.url).toMatch(/\/candidates\/20\/action$/);
  expect(JSON.parse(post.body ?? "{}")).toEqual({ action: "filled" });

  // Evidence: screenshot of the composer post-fill with Tweet enabled.
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "fill-composer-enabled.png"),
    fullPage: true,
  });

  writeFileSync(
    resolve(EVIDENCE_DIR, "actions-fill-console.txt"),
    consoleMessages.join("\n") + "\n",
    "utf8",
  );
  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});
