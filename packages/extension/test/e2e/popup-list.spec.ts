/**
 * CP08 E2E: popup candidate list.
 *
 * Golden path:
 *   seed 3 candidates → open popup → 3 cards visible
 *   → click dismiss on one → 2 cards remain
 *     (POST /candidates/:id/action fired with action="dismissed")
 *   → click Open on another → new tab opens the correct tweet_url
 *
 * Also covers:
 *   - empty state (no candidates) → "No candidates yet — run your agent."
 *   - error state (daemon unreachable) → retry button re-fetches
 *
 * Screenshots are written to the CP08 evidence directory for the
 * Evaluator: loaded-3-cards, after-dismiss-2-cards, empty-state,
 * error-state.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchWithExtension,
  startDaemon,
  type DaemonHandle,
  type ExtensionCtx,
} from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const EVIDENCE_DIR = resolve(
  repoRoot,
  ".harness/twitter-helper/checkpoints/08/iter-1/evidence",
);

interface SeedCandidate {
  tweet_id: string;
  tweet_url: string;
  author_handle: string;
  tweet_text: string;
  suggested_reply: string;
}

const THREE_CANDIDATES: SeedCandidate[] = [
  {
    tweet_id: "1001",
    tweet_url: "https://twitter.com/alice/status/1001",
    author_handle: "@alice",
    tweet_text: "Excited to ship the new Chrome extension today!",
    suggested_reply: "Congrats on the ship — what's the next milestone?",
  },
  {
    tweet_id: "1002",
    tweet_url: "https://twitter.com/bob/status/1002",
    author_handle: "@bob",
    tweet_text:
      "TypeScript config: moduleResolution: 'bundler' vs 'nodenext' — which do you pick?",
    suggested_reply:
      "Usually 'bundler' for Vite/esbuild apps and 'nodenext' for Node libs.",
  },
  {
    tweet_id: "1003",
    tweet_url: "https://twitter.com/carol/status/1003",
    author_handle: "@carol",
    tweet_text: "What's the cleanest way to persist a small JSON state file?",
    suggested_reply:
      "fs.writeFileSync to tmp then rename — atomic on POSIX, safe on crash.",
  },
];

async function seedCandidates(
  port: number,
  candidates: SeedCandidate[],
): Promise<void> {
  const body = {
    candidates: candidates.map((c) => ({
      id: `cand-${c.tweet_id}`,
      tweet_id: c.tweet_id,
      tweet_url: c.tweet_url,
      author_handle: c.author_handle,
      tweet_text: c.tweet_text,
      suggested_reply: c.suggested_reply,
      match_reason: "E2E harness seed",
      match_category: "selected",
      kb_refs: [],
    })),
  };
  const res = await fetch(`http://localhost:${port}/candidates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`seed failed: ${res.status} ${await res.text()}`);
  }
}

async function openPopup(
  context: BrowserContext,
  extensionId: string,
): Promise<{ page: Page; consoleErrors: string[] }> {
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return { page, consoleErrors };
}

// -------------------------------------------------------------------------
// Golden path: 3 cards → dismiss → 2 cards → open → new tab.
// -------------------------------------------------------------------------

test.describe("popup candidate list — golden path", () => {
  let daemon: DaemonHandle;
  let ext: ExtensionCtx;

  test.beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    daemon = await startDaemon();
    await seedCandidates(daemon.port, THREE_CANDIDATES);
    ext = await launchWithExtension();
  });

  test.afterAll(async () => {
    await ext?.close();
    await daemon?.stop();
  });

  test("seeded 3 → 3 cards → dismiss one → 2 → open another", async () => {
    const { page, consoleErrors } = await openPopup(
      ext.context,
      ext.extensionId,
    );

    // Record network traffic to the daemon.
    interface ReqEntry {
      ts: number;
      method: string;
      url: string;
      post_data: string | null;
    }
    const requestLog: ReqEntry[] = [];
    ext.context.on("request", (req) => {
      requestLog.push({
        ts: Date.now(),
        method: req.method(),
        url: req.url(),
        post_data: req.postData(),
      });
    });

    const cards = page.locator('[data-testid="twh-popup-card"]');
    await expect(cards).toHaveCount(3, { timeout: 5_000 });

    // Each card must show its author handle, tweet preview, reply preview,
    // an Open button, and a dismiss button.
    for (const cand of THREE_CANDIDATES) {
      const card = page.locator(
        `[data-testid="twh-popup-card"][data-id="${cand.tweet_id}"]`,
      );
      await expect(card).toBeVisible();
      await expect(card).toContainText(cand.author_handle);
      // First 40 chars of each preview should survive any truncation.
      await expect(card).toContainText(cand.tweet_text.slice(0, 40));
      await expect(card).toContainText(cand.suggested_reply.slice(0, 40));
      await expect(
        card.locator('[data-testid="twh-popup-open"]'),
      ).toBeVisible();
      await expect(
        card.locator('[data-testid="twh-popup-dismiss"]'),
      ).toBeVisible();
    }

    // Screenshot: loaded with 3 cards.
    await page.screenshot({
      path: resolve(EVIDENCE_DIR, "popup-loaded-3-cards.png"),
      fullPage: true,
    });

    // --- Dismiss the first card ----------------------------------------
    const victim = THREE_CANDIDATES[0]!;
    const dismissBtn = page
      .locator(`[data-testid="twh-popup-card"][data-id="${victim.tweet_id}"]`)
      .locator('[data-testid="twh-popup-dismiss"]');

    const dismissReq = ext.context.waitForEvent("request", {
      predicate: (req) =>
        req.method() === "POST" &&
        req.url().endsWith(`/candidates/${victim.tweet_id}/action`),
      timeout: 5_000,
    });

    await dismissBtn.click();
    const captured = await dismissReq;
    expect(JSON.parse(captured.postData() ?? "{}")).toEqual({
      action: "dismissed",
    });

    // Card removed optimistically.
    await expect(
      page.locator(
        `[data-testid="twh-popup-card"][data-id="${victim.tweet_id}"]`,
      ),
    ).toHaveCount(0);
    await expect(cards).toHaveCount(2);

    await page.screenshot({
      path: resolve(EVIDENCE_DIR, "popup-after-dismiss-2-cards.png"),
      fullPage: true,
    });

    // --- Click Open on another card ------------------------------------
    const target = THREE_CANDIDATES[1]!;
    const openBtn = page
      .locator(`[data-testid="twh-popup-card"][data-id="${target.tweet_id}"]`)
      .locator('[data-testid="twh-popup-open"]');

    const newPagePromise = ext.context.waitForEvent("page", {
      timeout: 5_000,
    });
    await openBtn.click();
    const newPage = await newPagePromise;
    // The new tab may redirect (twitter.com → x.com) before load
    // finishes, so we assert that SOME URL the tab has seen ends with
    // the correct path. `initialUrl` captures Chrome's first navigation
    // target, which is what chrome.tabs.create({url}) was passed.
    const initialUrl = newPage.url();
    const matches = [initialUrl, target.tweet_url].some((u) =>
      u.endsWith(`/status/${target.tweet_id}`),
    );
    expect(
      matches,
      `expected tab URL to end with /status/${target.tweet_id}, got ${initialUrl}`,
    ).toBe(true);
    await newPage.close();

    // --- Network log evidence ------------------------------------------
    writeFileSync(
      resolve(EVIDENCE_DIR, "popup-network-log.txt"),
      requestLog
        .filter((r) => r.url.includes(`:${daemon.port}`))
        .map(
          (r) =>
            `${new Date(r.ts).toISOString()} ${r.method} ${r.url}${
              r.post_data ? ` body=${r.post_data}` : ""
            }`,
        )
        .join("\n") + "\n",
      "utf8",
    );

    expect(
      consoleErrors,
      `unexpected console errors: ${consoleErrors.join(" | ")}`,
    ).toEqual([]);

    await page.close();
  });
});

// -------------------------------------------------------------------------
// Empty state: daemon reachable but no candidates.
// -------------------------------------------------------------------------

test.describe("popup candidate list — empty state", () => {
  let daemon: DaemonHandle;
  let ext: ExtensionCtx;

  test.beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    daemon = await startDaemon();
    ext = await launchWithExtension();
  });

  test.afterAll(async () => {
    await ext?.close();
    await daemon?.stop();
  });

  test("shows empty-state copy when daemon returns no candidates", async () => {
    const { page, consoleErrors } = await openPopup(
      ext.context,
      ext.extensionId,
    );

    await expect(
      page.getByText("No candidates yet — run your agent."),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="twh-popup-card"]'),
    ).toHaveCount(0);

    await page.screenshot({
      path: resolve(EVIDENCE_DIR, "popup-empty-state.png"),
      fullPage: true,
    });

    expect(
      consoleErrors,
      `unexpected console errors: ${consoleErrors.join(" | ")}`,
    ).toEqual([]);

    await page.close();
  });
});

// -------------------------------------------------------------------------
// Error state: daemon unreachable. Retry button brings the list back.
// -------------------------------------------------------------------------

test.describe("popup candidate list — error state + retry", () => {
  let ext: ExtensionCtx;

  test.beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    // Launch the extension with NO daemon running. The background worker's
    // port scan will exhaust and cache null; the popup should render the
    // error state.
    ext = await launchWithExtension();
  });

  test.afterAll(async () => {
    await ext?.close();
  });

  test("shows error state, then list after retry with live daemon", async () => {
    const { page, consoleErrors } = await openPopup(
      ext.context,
      ext.extensionId,
    );

    const errorBanner = page.locator('[data-testid="twh-popup-error"]');
    await expect(errorBanner).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="twh-popup-retry"]'),
    ).toBeVisible();

    await page.screenshot({
      path: resolve(EVIDENCE_DIR, "popup-error-state.png"),
      fullPage: true,
    });

    // Bring a daemon up, seed one candidate, click retry, assert list.
    const daemon = await startDaemon();
    try {
      await seedCandidates(daemon.port, [THREE_CANDIDATES[0]!]);
      await page.locator('[data-testid="twh-popup-retry"]').click();
      await expect(
        page.locator('[data-testid="twh-popup-card"]'),
      ).toHaveCount(1, { timeout: 5_000 });
    } finally {
      await daemon.stop();
    }

    expect(
      consoleErrors,
      `unexpected console errors: ${consoleErrors.join(" | ")}`,
    ).toEqual([]);

    await page.close();
  });
});
