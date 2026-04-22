/**
 * CP06 E2E: the spec's golden path.
 *
 *   seed candidate → click ✍️ → composer has text + Tweet button enabled
 *                   → reload                → click 👎 → widget unmounts
 *
 * This spec mirrors the acceptance criterion verbatim. It exists in
 * addition to the per-action specs so a regression on the flow itself
 * (not just a single action) is flagged as a distinct failure.
 *
 * Evidence: we snapshot the network log of this whole round-trip so the
 * Evaluator can see every request fired from extension boot → dismiss.
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

interface RequestLogEntry {
  ts: number;
  method: string;
  url: string;
  post_data: string | null;
}

test.beforeAll(async () => {
  env = await startCP06Env();
});

test.afterAll(async () => {
  await env?.teardown();
});

test("golden path: fill → reload → dismiss unmounts", async () => {
  const page = await env.ext.context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  const actionPosts: ActionPost[] = [];
  const requestLog: RequestLogEntry[] = [];
  page.on("request", (req) => {
    requestLog.push({
      ts: Date.now(),
      method: req.method(),
      url: req.url(),
      post_data: req.postData(),
    });
  });

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

  // --- Fill -------------------------------------------------------------
  await page.locator('[data-testid="twh-fill"]').click();
  await expect(page.locator('[data-testid="tweetTextarea_0"]')).toHaveText(
    "Hi Jack, great first tweet.",
  );
  await expect(page.locator('[data-testid="tweetButtonInline"]')).toBeEnabled();
  await page.waitForTimeout(200);

  // --- Reload -----------------------------------------------------------
  await page.reload();
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg.text().includes("[twitter-helper] suggestion available for 20"),
    timeout: 5_000,
  });
  await expect(dock).toBeVisible({ timeout: 5_000 });

  // --- Dismiss ----------------------------------------------------------
  await page.locator('[data-testid="twh-dismiss"]').click();
  await expect(dock).toHaveCount(0, { timeout: 2_000 });

  // --- Evidence ---------------------------------------------------------
  await page.waitForTimeout(200);
  // Drop the network log for the Evaluator.
  writeFileSync(
    resolve(EVIDENCE_DIR, "network-log.txt"),
    requestLog
      .map(
        (r) =>
          `${new Date(r.ts).toISOString()} ${r.method} ${r.url}${r.post_data ? ` body=${r.post_data}` : ""}`,
      )
      .join("\n") + "\n",
    "utf8",
  );

  // Must have fired: 1 filled + 1 dismissed.
  expect(actionPosts.length).toBe(2);
  expect(JSON.parse(actionPosts[0]!.body ?? "{}")).toEqual({ action: "filled" });
  expect(JSON.parse(actionPosts[1]!.body ?? "{}")).toEqual({
    action: "dismissed",
  });

  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});
