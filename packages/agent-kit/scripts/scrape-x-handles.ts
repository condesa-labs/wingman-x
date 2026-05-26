#!/usr/bin/env tsx
/**
 * scrape-x-handles.ts — walk each handle in
 * ~/.twitter-helper/kb/selected-handles.txt, open their profile
 * page (https://x.com/<handle>), extract the latest N tweets
 * (excluding pinned/reposts/replies on a best-effort basis), and
 * emit a single JSON array of RawTweet tuples to stdout.
 *
 * Dynamic rotation: always scrapes all Tier 1 (core) handles, then
 * randomly samples ROTATION_SAMPLE handles from the evaluated pool
 * (handle-evaluation.json, top scorers). This prevents filter-bubble
 * effects by introducing fresh sources every run.
 *
 * Env:
 *   CDP_URL            — default http://127.0.0.1:9223
 *   HANDLES_FILE       — default ~/.twitter-helper/kb/selected-handles.txt
 *   EVALUATION_FILE    — default ~/.twitter-helper/handle-evaluation.json
 *   PER_HANDLE         — how many tweets per handle, default 3
 *   PER_HANDLE_MS      — per-handle time budget, default 8000
 *   MAX_HANDLES        — hard cap on total handles per run, default 35
 *   ROTATION_SAMPLE    — how many from evaluated pool to sample, default 15
 *   ROTATION_POOL_SIZE — top N from evaluation to sample from, default 100
 *   MIN_EVAL_SCORE     — minimum evaluation score to be eligible, default 30
 */
import "../../../scripts/load-env.mjs";
import { chromium, type Page } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9223";
const HANDLES_FILE =
  process.env.HANDLES_FILE ??
  resolve(homedir(), ".twitter-helper/kb/selected-handles.txt");
const EVALUATION_FILE =
  process.env.EVALUATION_FILE ??
  resolve(homedir(), ".twitter-helper/handle-evaluation.json");
const PER_HANDLE = Number(process.env.PER_HANDLE ?? "3");
const PER_HANDLE_MS = Number(process.env.PER_HANDLE_MS ?? "8000");
const MAX_HANDLES = Number(process.env.MAX_HANDLES ?? "35");
const ROTATION_SAMPLE = Number(process.env.ROTATION_SAMPLE ?? "15");
const ROTATION_POOL_SIZE = Number(process.env.ROTATION_POOL_SIZE ?? "100");
const MIN_EVAL_SCORE = Number(process.env.MIN_EVAL_SCORE ?? "30");

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

interface EvaluationResult {
  handle: string;
  total: number;
}

interface EvaluationFile {
  results: EvaluationResult[];
}

function parseTier1Handles(): string[] {
  const text = readFileSync(HANDLES_FILE, "utf-8");
  const handles: string[] = [];
  let inTier1 = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## Tier 1")) { inTier1 = true; continue; }
    if (trimmed.startsWith("## Tier 2")) break;
    if (!inTier1) continue;
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;
    handles.push(trimmed.startsWith("@") ? trimmed.slice(1) : trimmed);
  }
  return handles;
}

function loadRotationPool(): string[] {
  if (!existsSync(EVALUATION_FILE)) {
    log("no evaluation file found — rotation pool empty");
    return [];
  }
  try {
    const data = JSON.parse(
      readFileSync(EVALUATION_FILE, "utf-8"),
    ) as EvaluationFile;
    return data.results
      .filter((r) => r.total >= MIN_EVAL_SCORE)
      .slice(0, ROTATION_POOL_SIZE)
      .map((r) => (r.handle.startsWith("@") ? r.handle.slice(1) : r.handle));
  } catch {
    log("failed to parse evaluation file — rotation pool empty");
    return [];
  }
}

function sampleWithoutReplacement(arr: string[], n: number): string[] {
  const copy = [...arr];
  const result: string[] = [];
  for (let i = 0; i < Math.min(n, copy.length); i++) {
    const idx = Math.floor(Math.random() * copy.length);
    const [picked] = copy.splice(idx, 1);
    if (picked !== undefined) result.push(picked);
  }
  return result;
}

function parseHandles(): string[] {
  const tier1 = parseTier1Handles();
  const tier1Set = new Set(tier1.map((h) => h.toLowerCase()));

  const rotationPool = loadRotationPool().filter(
    (h) => !tier1Set.has(h.toLowerCase()),
  );

  const sampled = sampleWithoutReplacement(rotationPool, ROTATION_SAMPLE);
  const combined = [...tier1, ...sampled];

  log(
    `tier1=${tier1.length} rotation_sampled=${sampled.length} total=${combined.length}`,
  );
  if (sampled.length > 0) {
    log(`rotation picks: ${sampled.map((h) => "@" + h).join(", ")}`);
  }

  return combined.slice(0, MAX_HANDLES);
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
        const tweetAuthor = m[1]!;
        const tweetId = m[2]!;
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
    if (ctx === undefined) {
      throw new Error("no browser context available from CDP session");
    }
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
