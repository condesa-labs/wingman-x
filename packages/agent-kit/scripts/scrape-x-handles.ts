#!/usr/bin/env tsx
/**
 * scrape-x-handles.ts — walk each handle in
 * ~/.twitter-helper/kb/selected-handles.txt, open their profile
 * page (https://x.com/<handle>), extract the latest N tweets
 * (excluding pinned/reposts/replies on a best-effort basis), and
 * emit a single JSON array of RawTweet tuples to stdout.
 *
 * Env:
 *   CDP_URL         — default http://localhost:9223
 *   HANDLES_FILE    — default ~/.twitter-helper/kb/selected-handles.txt
 *   PER_HANDLE      — how many tweets per handle, default 3
 *   PER_HANDLE_MS   — per-handle time budget, default 8000
 *   MAX_HANDLES     — hard cap on handles processed per run, default 14
 *                     (the file is tier-sorted; 14 = just Tier 1).
 *                     Set higher to sample into Tier 2 (background list).
 */
import "../../../scripts/load-env.mjs";
import { chromium, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CDP_URL = process.env.CDP_URL ?? "http://localhost:9223";
const HANDLES_FILE =
  process.env.HANDLES_FILE ??
  resolve(homedir(), ".twitter-helper/kb/selected-handles.txt");
const PER_HANDLE = Number(process.env.PER_HANDLE ?? "3");
const PER_HANDLE_MS = Number(process.env.PER_HANDLE_MS ?? "8000");
const MAX_HANDLES = Number(process.env.MAX_HANDLES ?? "14");

interface RawTweet {
  tweet_id: string;
  tweet_url: string;
  author_handle: string;
  tweet_text: string;
  is_repost?: boolean;
}

function log(s: string) {
  process.stderr.write(`[handles] ${s}\n`);
}

function parseHandles(): string[] {
  const text = readFileSync(HANDLES_FILE, "utf-8");
  // The file is tier-sorted: Tier 1 (priority) first, Tier 2 second.
  // We slice by MAX_HANDLES rather than splitting by section because
  // callers just want "the first N most-important" and the file is the
  // canonical ordering.
  const all = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => (l.startsWith("@") ? l.slice(1) : l));
  return all.slice(0, MAX_HANDLES);
}

async function scrapeHandle(
  page: Page,
  handle: string,
): Promise<RawTweet[]> {
  const url = `https://x.com/${handle}`;
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PER_HANDLE_MS,
    });
  } catch (err) {
    log(`${handle} goto failed: ${(err as Error).message.split("\n")[0]}`);
    return [];
  }

  // Wait briefly for tweet articles to hydrate
  try {
    await page.waitForSelector("article", { timeout: 5000 });
    await page.waitForTimeout(700);
  } catch {
    log(`${handle}: no articles rendered within 5s — skipping`);
    return [];
  }

  const tweets = await page.evaluate(
    ({ expectedHandle, limit }) => {
      const seen = new Set<string>();
      const out: {
        tweet_id: string;
        tweet_url: string;
        author_handle: string;
        tweet_text: string;
        is_repost: boolean;
      }[] = [];
      const articles = Array.from(document.querySelectorAll("article"));
      for (const art of articles) {
        // Profile pages render the handle's own tweets AND reposts
        // (reposts show the originator, not the profile). Detect
        // reposts via the "reposted" / "转推" affordance.
        const repostBanner =
          art.querySelector('[data-testid="socialContext"]')?.textContent ??
          "";
        const isRepost =
          /repost/i.test(repostBanner) || /转推|转贴/i.test(repostBanner);
        const statusLink = art.querySelector<HTMLAnchorElement>(
          'a[href*="/status/"][role="link"]',
        );
        const href = statusLink?.getAttribute("href") ?? "";
        const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
        if (!m) continue;
        const tweetAuthor = m[1];
        const tweetId = m[2];
        // On a profile page, we only want ORIGINAL tweets from that
        // handle — skip reposts and any article that surfaces a
        // different author.
        if (isRepost) continue;
        if (tweetAuthor.toLowerCase() !== expectedHandle.toLowerCase())
          continue;
        if (seen.has(tweetId)) continue;
        seen.add(tweetId);
        const textEl = art.querySelector('[data-testid="tweetText"]');
        const fallbackText = art.querySelector("[lang]");
        const tweetText = (
          textEl?.textContent ??
          fallbackText?.textContent ??
          ""
        ).trim();
        if (!tweetText) continue;
        out.push({
          tweet_id: tweetId,
          tweet_url: `https://x.com${href.split(/[?#]/)[0]}`,
          author_handle: "@" + tweetAuthor,
          tweet_text: tweetText,
          is_repost: false,
        });
        if (out.length >= limit) break;
      }
      return out;
    },
    { expectedHandle: handle, limit: PER_HANDLE },
  );

  log(`${handle}: extracted ${tweets.length}`);
  return tweets;
}

(async () => {
  const handles = parseHandles();
  log(`attaching to ${CDP_URL}`);
  log(`${handles.length} handles, ${PER_HANDLE}/handle`);

  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();

    const all: RawTweet[] = [];
    for (const handle of handles) {
      const tweets = await scrapeHandle(page, handle);
      all.push(...tweets);
    }

    await page.close();
    log(`total: ${all.length} tweets from ${handles.length} handles`);
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
  } finally {
    await browser.close().catch(() => {});
  }
})();
