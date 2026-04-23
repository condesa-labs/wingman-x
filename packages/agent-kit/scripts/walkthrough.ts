#!/usr/bin/env tsx
/**
 * walkthrough.ts — drive the end-to-end candidate flow on the
 * attached Chrome: open the tweet, expand the reply composer (Twitter's
 * collapsed "Post your reply" placeholder), wait for the Dock, click
 * Fill, verify the composer got populated. STOPS BEFORE CLICKING TWEET.
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";

const CDP_URL = process.env.CDP_URL ?? "http://localhost:9223";
const TWEET_URL =
  process.env.TWEET_URL ??
  "https://x.com/hyperagent/status/2044086411951808699";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/twh-walkthrough";

mkdirSync(OUT_DIR, { recursive: true });

function log(msg: string) {
  process.stdout.write(`[walk] ${msg}\n`);
}

async function shot(page: Page, name: string) {
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  log(`screenshot → ${path}`);
}

async function ensureComposerOpen(page: Page): Promise<boolean> {
  // Is the composer already open?
  const already = await page
    .locator('[data-testid="tweetTextarea_0"]')
    .count();
  if (already > 0) {
    log("composer already open (testid present)");
    return true;
  }
  // Try clicking Twitter's "Post your reply" placeholder. It has
  // several possible affordances; try them in order.
  const candidates = [
    'div[role="textbox"]',
    '[data-testid="tweetTextarea_0_label"]',
    'div[aria-label*="Post your reply" i]',
    'div[aria-label*="reply" i][role="button"]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) {
      log(`clicking reply placeholder: ${sel}`);
      try {
        await loc.click({ timeout: 3000 });
        await page.waitForSelector('[data-testid="tweetTextarea_0"]', {
          timeout: 5000,
        });
        log("composer opened");
        return true;
      } catch (err) {
        log(`  ${sel} click/wait failed: ${(err as Error).message.split("\n")[0]}`);
      }
    }
  }
  // Last resort: scroll to the bottom of the article and click the reply icon
  log("last-resort: try clicking article's [aria-label=Reply] icon");
  const replyIcon = page
    .locator('article [data-testid="reply"]')
    .first();
  if ((await replyIcon.count()) > 0) {
    await replyIcon.click({ timeout: 3000 });
    try {
      await page.waitForSelector('[data-testid="tweetTextarea_0"]', {
        timeout: 5000,
      });
      log("composer opened via reply icon");
      return true;
    } catch {
      log("reply icon clicked but testid still missing");
    }
  }
  return false;
}

(async () => {
  log(`attaching to ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];

    log(`opening tweet: ${TWEET_URL}`);
    const page = await ctx.newPage();
    await page.goto(TWEET_URL, { waitUntil: "domcontentloaded", timeout: 25000 });

    log("waiting for tweet article...");
    await page.waitForSelector("article", { timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot(page, "01-tweet-loaded");

    log("waiting for #twh-dock to mount...");
    try {
      await page.waitForSelector("#twh-dock", { timeout: 12000 });
    } catch {
      log("TIMEOUT: #twh-dock never appeared — content script may not be injecting");
      const diag = await page.evaluate(() => ({
        url: location.href,
        articles: document.querySelectorAll("article").length,
        knownTwhNodes: [...document.querySelectorAll('[id^="twh-"]')].map(
          (e) => e.id,
        ),
      }));
      log("diag: " + JSON.stringify(diag));
      await shot(page, "02-no-dock");
      throw new Error("Dock not mounted");
    }
    await page.waitForTimeout(500);
    await shot(page, "02-dock-mounted");

    const opened = await ensureComposerOpen(page);
    await shot(page, "03-composer-open");
    if (!opened) {
      log("ERROR: could not open Twitter composer — aborting before click");
      const diag = await page.evaluate(() => ({
        url: location.href,
        replyButtons: [
          ...document.querySelectorAll('[data-testid="reply"]'),
        ].length,
        editables: [...document.querySelectorAll('[contenteditable="true"]')]
          .length,
        knownTestids: [
          ...new Set(
            [...document.querySelectorAll("[data-testid]")].map(
              (e) => (e as HTMLElement).dataset.testid,
            ),
          ),
        ]
          .filter((t) => t?.toLowerCase().includes("tweet") || t?.toLowerCase().includes("reply"))
          .slice(0, 20),
      }));
      log("diag: " + JSON.stringify(diag));
      return;
    }

    log('clicking [data-testid="twh-fill"]');
    await page.locator('[data-testid="twh-fill"]').click();
    await page.waitForTimeout(1500);
    await shot(page, "04-after-fill-click");

    const composer = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="tweetTextarea_0"]',
      ) as HTMLElement | null;
      if (!el) return { found: false };
      return {
        found: true,
        text: el.innerText?.trim() ?? "",
        charCount: [...(el.innerText ?? "")].length,
      };
    });
    log("composer state: " + JSON.stringify(composer));

    const tweetBtn = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll(
          '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
        ),
      );
      return candidates.map((b) => ({
        testId: (b as HTMLElement).dataset.testid,
        ariaDisabled: b.getAttribute("aria-disabled"),
        disabled: (b as HTMLButtonElement).disabled ?? null,
      }));
    });
    log("tweet button: " + JSON.stringify(tweetBtn));

    log("STOP — walkthrough complete. Nothing was submitted.");
  } finally {
    await browser.close().catch(() => {});
  }
})();
