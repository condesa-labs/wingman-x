/**
 * CP07 E2E: Dock ↔ Card transitions + unified draggability.
 *
 * Flow (mirrors the spec's acceptance criteria list):
 *   1. Seed a candidate, serve the fixture, mount the Dock at default.
 *   2. Screenshot the Dock (`dock-before-expand.png`).
 *   3. Click ⇱ → Card mounts, Dock unmounts. Screenshot (`card-visible.png`).
 *   4. Assert Card displays `match_reason` and `suggested_reply` (full
 *      text) and renders the 5 action icons.
 *   5. Click ✍️ on the Card → composer filled (inherits CP06 behaviour).
 *   6. Drag the Card's header → assert storage updates. Screenshot
 *      (`card-after-drag.png`).
 *   7. Click ⇲ → Card unmounts, Dock reappears at Card's last position.
 *      Screenshot (`dock-after-collapse.png`).
 *   8. Reload → Dock (not Card) is visible at the persisted position,
 *      confirming the "Card not sticky" design choice documented in
 *      output-summary.md.
 *   9. Zero console errors throughout.
 *
 * The E2E intentionally does not assert on mid-transition DOM state
 * (that's covered by the state-machine unit test); CSS animations at 180
 * ms are too short to snap deterministically via Playwright.
 */
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startCP06Env,
  type CP06Env,
} from "./helpers/actions-env.js";
import { waitForServiceWorker } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const EVIDENCE_DIR = resolve(
  repoRoot,
  ".harness/twitter-helper/checkpoints/07/iter-1/evidence",
);

const SEED_REPLY = "Hi Jack, great first tweet.";
const SEED_MATCH_REASON = "E2E harness seed";

let env: CP06Env;

test.beforeAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  env = await startCP06Env({ suggestedReply: SEED_REPLY });
});

test.afterAll(async () => {
  await env?.teardown();
});

test("Dock ⇱ → Card → ✍️ fill → drag → ⇲ collapse → reload returns Dock", async () => {
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

  // Let the action POST through to the daemon — this is CP06 behaviour
  // and we rely on it (fill click fires POST action=filled).
  await page.goto(`${env.fixtureBase}/jack/status/20`);
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg.text().includes("[twitter-helper] suggestion available for 20"),
    timeout: 5_000,
  });

  const dock = page.locator("#twh-dock");
  await expect(dock).toBeVisible({ timeout: 5_000 });

  // --- Step 1: Screenshot the default Dock -------------------------------
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "dock-before-expand.png"),
    fullPage: true,
  });

  // Capture Dock's position BEFORE expand so we can verify the Card
  // appears at the same anchor.
  const dockBoxBefore = await dock.boundingBox();
  if (dockBoxBefore === null) {
    throw new Error("dock has no bounding box before expand");
  }

  // --- Step 2: Click ⇱ → Card appears -------------------------------------
  await page.locator('[data-testid="twh-expand"]').click();

  const card = page.locator("#twh-card");
  await expect(card).toBeVisible({ timeout: 2_000 });
  // Dock must have unmounted — spec forbids both states visible at once.
  await expect(dock).toHaveCount(0, { timeout: 2_000 });

  // --- Step 3: Card displays match reason + suggested reply + 5 actions --
  await expect(page.locator('[data-testid="twh-card-match-reason"]')).toHaveText(
    SEED_MATCH_REASON,
  );
  await expect(
    page.locator('[data-testid="twh-card-reply-preview"]'),
  ).toHaveText(SEED_REPLY);
  for (const testId of [
    "twh-card-fill",
    "twh-card-quote",
    "twh-card-save",
    "twh-card-regen",
    "twh-card-dismiss",
  ]) {
    await expect(page.locator(`[data-testid="${testId}"]`)).toBeVisible();
  }

  // Card should be anchored at (approximately) the Dock's pre-expand
  // position. Allow 30 px slack for the transition scale-from-center
  // offset at the moment of mount.
  const cardBox = await card.boundingBox();
  if (cardBox === null) throw new Error("card has no bounding box");
  expect(Math.abs(cardBox.x - dockBoxBefore.x)).toBeLessThanOrEqual(30);
  expect(Math.abs(cardBox.y - dockBoxBefore.y)).toBeLessThanOrEqual(30);

  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "card-visible.png"),
    fullPage: true,
  });

  // --- Step 4: Click ✍️ on Card → composer filled + button enabled -------
  const composer = page.locator('[data-testid="tweetTextarea_0"]');
  const tweetBtn = page.locator('[data-testid="tweetButtonInline"]');
  await expect(composer).toHaveText("");
  await expect(tweetBtn).toBeDisabled();

  await page.locator('[data-testid="twh-card-fill"]').click();
  await expect(composer).toHaveText(SEED_REPLY, { timeout: 5_000 });
  await expect(tweetBtn).toBeEnabled({ timeout: 5_000 });

  // --- Step 5: Drag the Card via its header ------------------------------
  const cardHandle = page.locator('[data-testid="twh-card-drag-handle"]');
  await expect(cardHandle).toBeVisible();
  const handleBox = await cardHandle.boundingBox();
  if (handleBox === null) throw new Error("card handle has no bounding box");
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const dropX = 160;
  const dropY = 380;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(dropX, dropY, { steps: 12 });
  await page.mouse.up();

  // Storage must reflect the new position (single source of truth with
  // the Dock). Round-trip through the service worker because
  // chrome.storage.local is not available in the page world.
  const worker = await waitForServiceWorker(env.ext.context);
  const afterCardDrag = (await worker.evaluate(async () => {
    const entry = await chrome.storage.local.get("widget_position");
    return entry["widget_position"] ?? null;
  })) as { x: number; y: number } | null;
  expect(afterCardDrag).not.toBeNull();
  expect(
    Math.abs((afterCardDrag as { x: number }).x - dropX),
  ).toBeLessThanOrEqual(40);
  expect(
    Math.abs((afterCardDrag as { y: number }).y - dropY),
  ).toBeLessThanOrEqual(40);

  const cardBoxAfterDrag = await card.boundingBox();
  if (cardBoxAfterDrag === null) {
    throw new Error("card has no bounding box after drag");
  }
  expect(cardBoxAfterDrag.x).toBeLessThan(400);
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "card-after-drag.png"),
    fullPage: true,
  });

  // --- Step 6: Click ⇲ → Dock reappears at the Card's anchor ------------
  await page.locator('[data-testid="twh-card-collapse"]').click();
  const dockRestored = page.locator("#twh-dock");
  await expect(dockRestored).toBeVisible({ timeout: 2_000 });
  await expect(card).toHaveCount(0, { timeout: 2_000 });

  const dockBoxAfterCollapse = await dockRestored.boundingBox();
  if (dockBoxAfterCollapse === null) {
    throw new Error("dock has no bounding box after collapse");
  }
  // The dock should be at (approximately) the card's last position.
  expect(
    Math.abs(dockBoxAfterCollapse.x - cardBoxAfterDrag.x),
  ).toBeLessThanOrEqual(30);
  expect(
    Math.abs(dockBoxAfterCollapse.y - cardBoxAfterDrag.y),
  ).toBeLessThanOrEqual(30);

  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "dock-after-collapse.png"),
    fullPage: true,
  });

  // --- Step 7: Reload → Card is NOT sticky; Dock returns ----------------
  await page.reload();
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg.text().includes("[twitter-helper] suggestion available for 20"),
    timeout: 5_000,
  });
  const dockAfterReload = page.locator("#twh-dock");
  await expect(dockAfterReload).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#twh-card")).toHaveCount(0);

  // Persisted position still reflects the drag done while the Card was
  // active — same storage key, single source of truth.
  const restored = await dockAfterReload.boundingBox();
  if (restored === null) throw new Error("dock has no bounding box after reload");
  expect(Math.abs(restored.x - dockBoxAfterCollapse.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(restored.y - dockBoxAfterCollapse.y)).toBeLessThanOrEqual(1);

  // --- Step 8: Evidence + zero console errors ---------------------------
  writeFileSync(
    resolve(EVIDENCE_DIR, "card-console.txt"),
    consoleMessages.join("\n") + "\n",
    "utf8",
  );
  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});
