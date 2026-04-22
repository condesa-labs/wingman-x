/**
 * CP03 E2E: load unpacked extension → open popup → empty state visible,
 * zero console errors; then simulate service-worker suspension and
 * re-open the popup, asserting the flow still works.
 *
 * The daemon is spawned as a real child process so the background
 * worker's `/health` scan resolves a real port in the 53827–53836 range.
 */
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
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
// Evidence directory is anchored at the harness checkpoint.
const evidenceDir = resolve(
  __dirname,
  "../../../../.harness/twitter-helper/checkpoints/03/iter-1/evidence",
);

let daemon: DaemonHandle;
let ext: ExtensionCtx;

test.beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  daemon = await startDaemon();
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await daemon?.stop();
});

test("popup shows empty state with zero console errors on fresh launch", async () => {
  const popupUrl = `chrome-extension://${ext.extensionId}/popup.html`;
  const page = await ext.context.newPage();

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto(popupUrl);

  // The empty-state copy must match the spec exactly.
  const emptyState = page.getByText("No candidates yet — run your agent.");
  await expect(emptyState).toBeVisible({ timeout: 2_000 });

  // Port resolution should complete; the debug footer renders once the
  // port is cached. Allow up to 1s since the scan is typically <100ms.
  const footer = page.locator("[data-testid='port-status']");
  await expect(footer).toContainText(/Connected to daemon on port \d+/, {
    timeout: 1_000,
  });

  // Screenshot evidence.
  await page.screenshot({
    path: `${evidenceDir}/popup-empty-state.png`,
    fullPage: true,
  });

  expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual(
    [],
  );

  await page.close();
});

test("popup still opens correctly after service-worker suspension", async () => {
  // Grab the current worker and stop it to simulate the 30s+ idle
  // shutdown that Chrome does on its own. This is deterministic and
  // fast; a 35s wait is the documented fallback.
  const worker = await waitForServiceWorker(ext.context);
  await ext.context.request
    .fetch(`${worker.url()}`)
    .catch(() => {
      /* the worker url is a script, GETting it is a no-op side-effect */
    });

  // The most reliable suspension trigger in Playwright as of 1.49:
  // `context.serviceWorkers()[0].evaluate(() => self.registration.unregister())`
  // would kill the worker permanently; instead we stop & let Chrome
  // restart it on the next event (popup open → action.onClicked chain).
  // Implementation: use CDP to stop the worker.
  const cdp = await ext.context.newCDPSession(
    await ext.context.newPage(),
  );
  // Target: the service worker. Find its target id.
  const targets = await cdp.send("Target.getTargets");
  const swTarget = targets.targetInfos.find(
    (t) => t.type === "service_worker" && t.url === worker.url(),
  );
  if (swTarget) {
    await cdp.send("Target.closeTarget", { targetId: swTarget.targetId });
  }

  // Give Chrome a moment, then verify opening the popup still works.
  // Opening a new page on the popup URL triggers the extension which
  // wakes the service worker.
  const popupUrl = `chrome-extension://${ext.extensionId}/popup.html`;
  const page = await ext.context.newPage();

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto(popupUrl);

  await expect(
    page.getByText("No candidates yet — run your agent."),
  ).toBeVisible({ timeout: 5_000 });

  // After suspension + re-wake, the footer should again show a port.
  await expect(page.locator("[data-testid='port-status']")).toContainText(
    /Connected to daemon on port \d+/,
    { timeout: 3_000 },
  );

  await page.screenshot({
    path: `${evidenceDir}/popup-after-suspend.png`,
    fullPage: true,
  });

  expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual(
    [],
  );

  await page.close();
});
