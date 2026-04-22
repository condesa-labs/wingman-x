/**
 * CP10 — End-to-end integration smoke.
 *
 * Proves the whole pipe works: agent-kit → daemon → extension → composer.
 *
 * Flow under test:
 *   1. Spawn a real daemon on a disposable state dir.
 *   2. Use `@twitter-helper/agent-kit`'s `createDaemonClient` as the
 *      "agent simulator" to POST one candidate. This deliberately
 *      exercises the public agent-kit surface instead of a raw fetch,
 *      because CP09 shipped the client as the agent-facing contract.
 *   3. Serve the repo's `test/fixtures/tweet-detail.html` on localhost
 *      — the extension's MV3 manifest matches
 *      `http://localhost/*\/status\/*` so the content script runs here
 *      without touching real twitter.com.
 *   4. Launch Chromium with the unpacked extension.
 *   5. Navigate to `/<handle>/status/<tweet_id>`.
 *   6. Assert the Dock mounts (#twh-dock visible).
 *   7. Click the ✍️ icon.
 *   8. Assert Twitter's native composer contains the seeded
 *      `suggested_reply`.
 *   9. Assert the Tweet button flips from disabled → enabled — proves
 *      the React-compatible insertion path dispatches `input` events.
 *  10. Screenshot each stage into `.harness/.../10/iter-1/evidence/`.
 *  11. Assert zero console errors throughout.
 *
 * Why duplicate some of CP06's setup instead of reusing `startCP06Env`?
 *   - CP06's helper pre-seeds via raw fetch; CP10's acceptance criteria
 *     require the agent-kit client to drive the seed (the "agent
 *     simulator" requirement).
 *   - CP06's helper pins EVIDENCE_DIR to the CP06 iteration folder.
 *   - The low-level primitives (`startDaemon`, `launchWithExtension`,
 *     `startFixtureServer`) are shared — we re-use them and only
 *     inline the seed-via-client + CP10 evidence path here.
 */
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemonClient } from "@twitter-helper/agent-kit";
import {
  launchWithExtension,
  startDaemon,
  type DaemonHandle,
  type ExtensionCtx,
} from "./fixtures.js";
import { startFixtureServer } from "./helpers/actions-env.js";
import type { Server } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const EVIDENCE_DIR = resolve(
  repoRoot,
  ".harness/twitter-helper/checkpoints/10/iter-1/evidence",
);

const SUGGESTED_REPLY = "Hi Jack, great first tweet.";

interface PipelineEnv {
  daemon: DaemonHandle;
  ext: ExtensionCtx;
  fixture: { base: string; server: Server };
}

let env: PipelineEnv;

test.beforeAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const daemon = await startDaemon();
  const fixture = await startFixtureServer();
  const ext = await launchWithExtension();
  env = { daemon, ext, fixture };
});

test.afterAll(async () => {
  if (!env) return;
  await env.ext.close().catch(() => {});
  await env.daemon.stop().catch(() => {});
  await new Promise<void>((res) => {
    env.fixture.server.close(() => res());
  });
});

test("agent → daemon → extension → composer fill (happy path)", async () => {
  // --- 1. Agent simulator: POST candidates via @twitter-helper/agent-kit ---
  const client = createDaemonClient(env.daemon.port);
  const { accepted } = await client.postCandidates([
    {
      id: "cand-20",
      tweet_id: "20",
      // Using a localhost URL here doesn't affect the match: the
      // content script resolves tweet_id from `location.pathname`
      // (/jack/status/20), not from this field. We still include a
      // realistic value so the stored record round-trips cleanly.
      tweet_url: "https://twitter.com/jack/status/20",
      author_handle: "@jack",
      tweet_text: "just setting up my twttr",
      suggested_reply: SUGGESTED_REPLY,
      match_reason: "CP10 full-pipeline E2E seed",
      match_category: "selected",
      kb_refs: [],
    },
  ]);
  expect(accepted, "daemon should have stored exactly 1 candidate").toBe(1);

  // --- 2. Launch a page with console + pageerror capture ---
  const page = await env.ext.context.newPage();
  const consoleMessages: string[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(err.message);
    consoleMessages.push(`[pageerror] ${err.message}`);
  });

  // --- 3. Navigate to the local fixture (not real twitter.com) ---
  await page.goto(`${env.fixture.base}/jack/status/20`);

  // Wait for the content script's "suggestion available" log — the
  // canary that the background → content → /suggestion → dock.mount
  // chain all fired. Avoids the race of asserting on #twh-dock while
  // the suggestion fetch is still in flight.
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg.text().includes("[twitter-helper] suggestion available for 20"),
    timeout: 10_000,
  });

  // --- 4. Assert Dock visible ---
  const dock = page.locator("#twh-dock");
  await expect(dock).toBeVisible({ timeout: 5_000 });

  // Screenshot: fixture page with Dock mounted.
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "fixture-with-dock.png"),
    fullPage: true,
  });

  // --- 5. Pre-click sanity: composer empty, Tweet button disabled ---
  const composer = page.locator('[data-testid="tweetTextarea_0"]');
  const tweetBtn = page.locator('[data-testid="tweetButtonInline"]');
  await expect(composer).toHaveText("");
  await expect(tweetBtn).toBeDisabled();

  // --- 6. Click ✍️ ---
  await page.locator('[data-testid="twh-fill"]').click();

  // --- 7. Assert composer contains suggested_reply ---
  await expect(composer).toHaveText(SUGGESTED_REPLY, { timeout: 5_000 });

  // --- 8. Assert Tweet button flipped enabled — proves React-compatible
  //        insertion dispatched `input` events (spec's React-sync check) ---
  await expect(tweetBtn).toBeEnabled({ timeout: 5_000 });

  // Screenshot: composer post-fill with Tweet button enabled.
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "composer-post-fill.png"),
    fullPage: true,
  });

  // --- 9. Persist console log + assert zero errors ---
  writeFileSync(
    resolve(EVIDENCE_DIR, "full-pipeline-console.txt"),
    consoleMessages.join("\n") + "\n",
    "utf8",
  );
  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});
