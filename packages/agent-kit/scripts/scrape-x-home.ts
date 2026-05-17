#!/usr/bin/env tsx
/**
 * scrape-x-home.ts — attach to a Chrome running with
 * `--remote-debugging-port=<N>` via Playwright's `connectOverCDP`,
 * walk the x.com home timeline, and emit a JSON array of raw tweet
 * tuples to stdout. This is intentionally a *pure scraper*: it does
 * NOT touch the KB or the daemon. Drafting replies + POSTing is the
 * agent (LLM) side of the workflow.
 *
 * Env:
 *   CDP_URL       — default http://localhost:9222
 *   MAX_TWEETS    — default 20 (hard cap per run)
 *   MAX_SCROLLS   — default 20
 *   SCROLL_DELAY  — default 900 (ms between wheel + extract)
 *
 * Exits non-zero on login gate or DOM-churn degradation, matching the
 * failure-mode contract in docs/agent-workflow.md.
 */
import "../../../scripts/load-env.mjs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const CDP_URL = process.env.CDP_URL ?? "http://localhost:9222";
const MAX_TWEETS = Number(process.env.MAX_TWEETS ?? "20");
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS ?? "20");
const SCROLL_DELAY = Number(process.env.SCROLL_DELAY ?? "900");

interface RawTweet {
  tweet_id: string;
  tweet_url: string;
  author_handle: string;
  tweet_text: string;
}

function log(msg: string): void {
  process.stderr.write(`[scrape] ${msg}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function findOrOpenHome(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  const existing = pages.find((p) =>
    /https:\/\/(?:www\.)?(?:x|twitter)\.com\/home\b/.test(p.url()),
  );
  if (existing) {
    log(`using existing x.com/home tab: ${existing.url()}`);
    await existing.bringToFront();
    return existing;
  }
  log("no x.com/home tab found — opening a new one");
  const page = await browser.newPage();
  await page.goto("https://x.com/home", {
    waitUntil: "domcontentloaded",
    timeout: 25000,
  });
  return page;
}

async function detectLoginGate(page: Page): Promise<{
  loggedIn: boolean;
  url: string;
  articleCount: number;
}> {
  await delay(1500);
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await page.evaluate(() => ({
      url: location.href,
      pathname: location.pathname,
      search: location.search,
      articleCount: document.querySelectorAll("article").length,
    }));
    const redirected = /[?&]logout=|\/i\/flow\/login/.test(
      info.pathname + info.search,
    );
    if (!redirected && info.articleCount > 0) {
      return { loggedIn: true, url: info.url, articleCount: info.articleCount };
    }
    if (redirected) {
      return { loggedIn: false, url: info.url, articleCount: info.articleCount };
    }
    await delay(1500);
  }
  const final = await page.evaluate(() => ({
    url: location.href,
    articleCount: document.querySelectorAll("article").length,
  }));
  return {
    loggedIn: final.articleCount > 0,
    url: final.url,
    articleCount: final.articleCount,
  };
}

async function extractVisibleTweets(page: Page): Promise<RawTweet[]> {
  return page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll("article"));
    const out: {
      tweet_id: string;
      tweet_url: string;
      author_handle: string;
      tweet_text: string;
    }[] = [];
    for (const art of articles) {
      const statusLink = art.querySelector<HTMLAnchorElement>(
        'a[href*="/status/"][role="link"]',
      );
      const href = statusLink?.getAttribute("href") ?? "";
      const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
      if (!m) continue;
      const author_handle = "@" + m[1];
      const tweet_id = m[2];
      const tweet_url = `https://x.com${href.split(/[?#]/)[0]}`;
      const textEl = art.querySelector('[data-testid="tweetText"]');
      const fallbackText = art.querySelector('[lang]');
      const tweet_text = (
        textEl?.textContent ?? fallbackText?.textContent ?? ""
      ).trim();
      if (!tweet_text) continue;
      out.push({ tweet_id, tweet_url, author_handle, tweet_text });
    }
    return out;
  });
}

async function scrapeBounded(page: Page): Promise<RawTweet[]> {
  const seen = new Set<string>();
  const results: RawTweet[] = [];
  let stagnantScrolls = 0;

  for (let step = 0; step < MAX_SCROLLS; step++) {
    const batch = await extractVisibleTweets(page);
    let added = 0;
    for (const t of batch) {
      if (!seen.has(t.tweet_id)) {
        seen.add(t.tweet_id);
        results.push(t);
        added++;
        if (results.length >= MAX_TWEETS) break;
      }
    }
    log(
      `scroll ${step + 1}/${MAX_SCROLLS}: added ${added}, total ${results.length}`,
    );
    if (results.length >= MAX_TWEETS) break;
    if (added === 0) {
      stagnantScrolls++;
      if (stagnantScrolls >= 3) {
        log("3 stagnant scrolls — stopping (feed exhausted or throttled)");
        break;
      }
    } else {
      stagnantScrolls = 0;
    }
    await page.evaluate(() => window.scrollBy(0, 1800));
    await delay(SCROLL_DELAY);
  }
  return results.slice(0, MAX_TWEETS);
}

async function main(): Promise<void> {
  log(`connecting to ${CDP_URL}`);
  const browser = await puppeteer.connect({ browserURL: CDP_URL });
  try {
    const page = await findOrOpenHome(browser);

    const gate = await detectLoginGate(page);
    log(`login probe: ${JSON.stringify(gate)}`);
    if (!gate.loggedIn) {
      throw new Error(
        `LOGIN_GATE: url=${gate.url} articles=${gate.articleCount} — sign into x.com in the attached Chrome, then re-run.`,
      );
    }

    const results = await scrapeBounded(page);
    if (results.length === 0) {
      throw new Error(
        "DOM_CHURN: 0 tweets extracted despite logged-in state — selectors likely changed.",
      );
    }
    log(`extracted ${results.length} unique tweets`);
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  } finally {
    browser.disconnect();
  }
}

main().catch((err: Error) => {
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
