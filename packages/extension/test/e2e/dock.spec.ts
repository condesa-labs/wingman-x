/**
 * CP05 E2E: Dock widget renders when `/suggestion` returns 200, is draggable
 * via the ⋮⋮ handle, and its position persists across a page reload.
 *
 * Flow:
 *   1. Start a real daemon on a disposable state dir.
 *   2. Seed a candidate with tweet_id="20" so GET /suggestion?tweet_id=20 → 200.
 *   3. Start a tiny HTTP server that serves the fixture at /jack/status/20.
 *   4. Launch Chromium with the unpacked extension.
 *   5. Navigate to the fixture → assert Dock visible with 7 icons and the
 *      primary-highlight styling on ✍️.
 *   6. Assert clicks on action icons fire NO network calls (CP05 inertness).
 *   7. Drag the Dock via the ⋮⋮ handle → assert new position saved to
 *      chrome.storage.local under `widget_position`.
 *   8. Reload → assert Dock restores the saved position (within 1 px).
 *   9. Capture screenshots (default + dragged) as evidence.
 *   10. Assert zero console errors throughout.
 */
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchWithExtension,
  startDaemon,
  waitForServiceWorker,
  type DaemonHandle,
  type ExtensionCtx,
} from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const fixturePath = resolve(repoRoot, "test/fixtures/tweet-detail.html");
const evidenceDir = resolve(
  repoRoot,
  ".harness/twitter-helper/checkpoints/05/iter-1/evidence",
);

let daemon: DaemonHandle;
let ext: ExtensionCtx;
let fixtureServer: http.Server;
let fixtureBase: string;
/**
 * Running totals for candidate-action calls during the whole spec. We
 * assert this is zero after the "inert click" step — CP05 forbids any
 * network wiring on action icons (that lands in CP06).
 */
let actionCallCount = 0;

async function startFixtureServer(): Promise<{
  base: string;
  server: http.Server;
}> {
  const fixtureHtml = readFileSync(fixturePath, "utf8");
  const server = http.createServer((req, res) => {
    const urlPath = req.url ?? "/";
    if (/^\/[^/]+\/status\/\d+\/?(\?.*)?$/.test(urlPath)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixtureHtml);
      return;
    }
    // 204 for favicon.ico etc. — keeps console clean per CP04 pattern.
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address() as AddressInfo;
  return { base: `http://localhost:${addr.port}`, server };
}

async function seedCandidate(port: number, tweetId: string): Promise<void> {
  const body = {
    candidates: [
      {
        id: `cand-${tweetId}`,
        tweet_id: tweetId,
        tweet_url: `https://twitter.com/jack/status/${tweetId}`,
        author_handle: "@jack",
        tweet_text: "Hello, Twitter.",
        suggested_reply: "Hi Jack, great first tweet.",
        match_reason: "E2E harness seed",
        match_category: "selected",
        kb_refs: [],
      },
    ],
  };
  const res = await fetch(`http://localhost:${port}/candidates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`seed candidate failed: ${res.status} ${await res.text()}`);
  }
}

test.beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  daemon = await startDaemon();
  await seedCandidate(daemon.port, "20");
  const fs = await startFixtureServer();
  fixtureServer = fs.server;
  fixtureBase = fs.base;
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await daemon?.stop();
  await new Promise<void>((resolveClose) => {
    fixtureServer?.close(() => resolveClose());
  });
});

test("Dock renders, icons inert, position persists across reload", async () => {
  const page = await ext.context.newPage();

  // --- Console tracking ----------------------------------------------------
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

  // --- Network tracking ----------------------------------------------------
  // The spec: "Click on non-drag-handle areas does NOT trigger any network
  // call yet (wiring lands in CP06)." We route ALL /candidates/** requests
  // to a counter and then click each icon; the counter must remain 0.
  actionCallCount = 0;
  await page.route("**/candidates/**", async (route) => {
    actionCallCount += 1;
    // Fulfil with a 500 so that, if the production code ever fires, the
    // resulting console.error surfaces clearly rather than silently
    // succeeding. We still count the attempt above.
    await route.fulfill({ status: 500, body: "unexpected-call" });
  });

  // --- Step 1: Navigate and see the Dock ----------------------------------
  await page.goto(`${fixtureBase}/jack/status/20`);

  // Wait for the content script to confirm it received a 200 suggestion.
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg.text().includes("[twitter-helper] suggestion available for 20"),
    timeout: 5_000,
  });

  // Dock is mounted into the page DOM. We use a stable id.
  const dock = page.locator("#twh-dock");
  await expect(dock).toBeVisible({ timeout: 5_000 });

  // --- Step 2: 7 icon elements + primary highlight -----------------------
  const handle = page.locator('[data-testid="twh-drag-handle"]');
  await expect(handle).toBeVisible();

  const expectedActions = [
    "twh-fill",
    "twh-quote",
    "twh-save",
    "twh-regen",
    "twh-dismiss",
    "twh-expand",
  ];
  for (const testId of expectedActions) {
    const btn = page.locator(`[data-testid="${testId}"]`);
    await expect(btn).toBeVisible();
  }
  // Confirm exactly 7 elements (1 handle + 6 actions) are present — no
  // extras snuck in.
  const totalIcons = await dock.locator("[data-testid^='twh-']").count();
  expect(totalIcons).toBe(7);

  // Primary ✍️ must be visually distinct. We assert on a computed style
  // property we explicitly set on `.twh-primary` (background color).
  const primaryBg = await page
    .locator('[data-testid="twh-fill"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const otherBg = await page
    .locator('[data-testid="twh-quote"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(primaryBg).not.toBe(otherBg);

  // --- Step 3: Capture "default position" screenshot --------------------
  await page.screenshot({
    path: resolve(evidenceDir, "dock-default-position.png"),
    fullPage: true,
  });

  // --- Step 4: Clicks on non-handle icons must NOT hit the network -------
  for (const testId of expectedActions) {
    await page.locator(`[data-testid="${testId}"]`).click();
  }
  // Tiny drain loop in case the production code fires fetch()
  // asynchronously. Playwright's route handler is synchronous so any hit
  // would already be counted, but we give it a microtask grace window.
  await page.waitForTimeout(100);
  expect(
    actionCallCount,
    `expected zero /candidates/** calls from action clicks — got ${actionCallCount}`,
  ).toBe(0);

  // --- Step 5: Drag the Dock via the ⋮⋮ handle ---------------------------
  const handleBox = await handle.boundingBox();
  if (handleBox === null) {
    throw new Error("drag handle has no bounding box");
  }
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const dropX = 180;
  const dropY = 420;

  // Use a deliberate multi-step move so pointermove listeners attached in
  // production code have a chance to fire. Playwright's `mouse.move()`
  // without steps jumps in one event which some drag handlers ignore.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(dropX, dropY, { steps: 10 });
  await page.mouse.up();

  // After pointerup the content script must have persisted the new
  // position. We can't access chrome.storage.local from `page.evaluate`
  // (it's not injected into the page world), so we roundtrip through the
  // extension's service worker, where `chrome.storage.local` IS available.
  const worker = await waitForServiceWorker(ext.context);
  const afterDrag = (await worker.evaluate(async () => {
    const entry = await chrome.storage.local.get("widget_position");
    return entry["widget_position"] ?? null;
  })) as { x: number; y: number } | null;

  // Snapshot storage state before + after drag for evidence.
  writeFileSync(
    resolve(evidenceDir, "storage-widget-position.json"),
    JSON.stringify(
      {
        after_drag: afterDrag,
        drop_coords_used_by_test: { x: dropX, y: dropY },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  expect(afterDrag).not.toBeNull();
  // The persisted position should match where we released the pointer
  // within a small tolerance (pointer is on handle centre, dock top-left
  // is a few px offset — exact offset depends on handle padding).
  expect(Math.abs((afterDrag as { x: number }).x - dropX)).toBeLessThanOrEqual(
    30,
  );
  expect(Math.abs((afterDrag as { y: number }).y - dropY)).toBeLessThanOrEqual(
    30,
  );

  // Dock visually moved to the new location.
  const boxAfter = await dock.boundingBox();
  if (boxAfter === null) throw new Error("dock has no bounding box after drag");
  // Must have moved at least 50 px from its default right-edge anchor.
  expect(boxAfter.x).toBeLessThan(400);

  await page.screenshot({
    path: resolve(evidenceDir, "dock-after-drag.png"),
    fullPage: true,
  });

  // --- Step 6: Reload → dock reappears at the saved position -------------
  await page.reload();
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg.text().includes("[twitter-helper] suggestion available for 20"),
    timeout: 5_000,
  });
  const dockAfterReload = page.locator("#twh-dock");
  await expect(dockAfterReload).toBeVisible({ timeout: 5_000 });

  const boxRestored = await dockAfterReload.boundingBox();
  if (boxRestored === null)
    throw new Error("dock has no bounding box after reload");
  expect(Math.abs(boxRestored.x - boxAfter.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxRestored.y - boxAfter.y)).toBeLessThanOrEqual(1);

  // --- Step 7: Evidence + zero console errors ----------------------------
  writeFileSync(
    resolve(evidenceDir, "console-log.txt"),
    consoleMessages.join("\n") + "\n",
    "utf8",
  );
  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});
