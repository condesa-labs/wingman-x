#!/usr/bin/env tsx
/**
 * evaluate-handles.ts — scan ALL handles from selected-handles.txt,
 * evaluate each on three criteria:
 *   1. AI relevance (bio + content keywords)
 *   2. Engagement (avg views/likes per tweet)
 *   3. Interactivity (does the author reply to comments?)
 *
 * Outputs scored JSON to stdout. Runs concurrent browser tabs for speed.
 *
 * Env:
 *   CDP_URL         — default http://127.0.0.1:9223
 *   HANDLES_FILE    — default ~/.twitter-helper/kb/selected-handles.txt
 *   CONCURRENCY     — parallel tabs, default 4
 *   PER_HANDLE_MS   — timeout per profile visit, default 12000
 *   SKIP_TIER1      — skip Tier 1 handles (already curated), default true
 *   OUTPUT_FILE     — write results here (in addition to stdout)
 */
import "../../../scripts/load-env.mjs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9223";
const HANDLES_FILE =
  process.env.HANDLES_FILE ??
  resolve(homedir(), ".twitter-helper/kb/selected-handles.txt");
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "2");
const PER_HANDLE_MS = Number(process.env.PER_HANDLE_MS ?? "12000");
const INTER_HANDLE_DELAY_MS = Number(process.env.INTER_HANDLE_DELAY_MS ?? "3000");
const SKIP_TIER1 = process.env.SKIP_TIER1 !== "false";
const OUTPUT_FILE =
  process.env.OUTPUT_FILE ??
  resolve(homedir(), ".twitter-helper/handle-evaluation.json");

const AI_KEYWORDS = /\b(ai|artificial intelligence|machine learning|ml|llm|gpt|claude|openai|anthropic|deep ?learning|neural|transformer|rag|agent|langchain|diffusion|gen ?ai|generative|nlp|computer vision|robotics|mcp|prompt|fine.?tun|embedding|vector|rlhf|llama|mistral|gemini)\b/i;

const AI_BIO_STRONG = /\b(ai|agi|ml|llm|deep ?learning|machine learning|artificial (?:general )?intelligence|gen ?ai|nlp|computer vision|openai|anthropic|neural)\b/i;

interface HandleScore {
  handle: string;
  bio: string;
  ai_relevance: number;
  engagement: number;
  interactivity: number;
  total: number;
  details: {
    avg_views: number;
    avg_likes: number;
    tweet_count_sampled: number;
    ai_tweets_ratio: number;
    replies_by_author: number;
    bio_ai_match: boolean;
  };
}

function log(s: string) {
  process.stderr.write(`[eval] ${s}\n`);
}

function parseHandles(): { tier1: string[]; tier2: string[] } {
  const text = readFileSync(HANDLES_FILE, "utf-8");
  const tier1: string[] = [];
  const tier2: string[] = [];
  let section: "tier1" | "tier2" | "none" = "none";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## Tier 1")) {
      section = "tier1";
      continue;
    }
    if (trimmed.startsWith("## Tier 2")) {
      section = "tier2";
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;
    const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    if (section === "tier1") tier1.push(handle);
    else if (section === "tier2") tier2.push(handle);
  }
  return { tier1, tier2 };
}

async function evaluateHandle(
  page: Page,
  handle: string,
): Promise<HandleScore | null> {
  const url = `https://x.com/${handle}`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PER_HANDLE_MS });
  } catch (err) {
    log(`${handle}: goto failed - ${(err as Error).message.split("\n")[0]}`);
    return null;
  }

  try {
    await page.waitForSelector('[data-testid="UserDescription"], article', {
      timeout: 6000,
    });
    await page.waitForTimeout(800);
  } catch {
    log(`${handle}: page did not render profile or tweets`);
    return null;
  }

  const data = await page.evaluate(
    ({ handle: h }) => {
      const bioEl = document.querySelector('[data-testid="UserDescription"]');
      const bio = bioEl?.textContent?.trim() ?? "";

      const articles = Array.from(document.querySelectorAll("article"));
      const tweets: Array<{
        text: string;
        isReply: boolean;
        authorIsHandle: boolean;
        views: number;
        likes: number;
        retweets: number;
        replies: number;
      }> = [];

      for (const art of articles) {
        const statusLink = art.querySelector<HTMLAnchorElement>(
          'a[href*="/status/"][role="link"]',
        );
        const href = statusLink?.getAttribute("href") ?? "";
        const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
        if (!m) continue;

        const tweetAuthor = m[1].toLowerCase();
        const authorIsHandle = tweetAuthor === h.toLowerCase();

        const textEl = art.querySelector('[data-testid="tweetText"]');
        const text = textEl?.textContent?.trim() ?? "";

        // Check if it's a reply (has "Replying to" or reply context)
        const replyContext = art.querySelector('[data-testid="socialContext"]');
        const replyingTo = art.textContent?.includes("Replying to") ?? false;
        const isReply = replyingTo || (replyContext?.textContent?.includes("replied") ?? false);

        // Extract engagement metrics from aria-labels
        let views = 0, likes = 0, retweets = 0, replies = 0;
        const groups = art.querySelectorAll('[role="group"]');
        for (const group of groups) {
          const labels = group.querySelectorAll('[aria-label]');
          for (const label of labels) {
            const ariaLabel = label.getAttribute("aria-label") ?? "";
            const viewMatch = ariaLabel.match(/(\d[\d,]*)\s*view/i);
            const likeMatch = ariaLabel.match(/(\d[\d,]*)\s*like/i);
            const rtMatch = ariaLabel.match(/(\d[\d,]*)\s*(?:repost|retweet)/i);
            const replyMatch = ariaLabel.match(/(\d[\d,]*)\s*repl/i);
            if (viewMatch) views = Number(viewMatch[1].replace(/,/g, ""));
            if (likeMatch) likes = Number(likeMatch[1].replace(/,/g, ""));
            if (rtMatch) retweets = Number(rtMatch[1].replace(/,/g, ""));
            if (replyMatch) replies = Number(replyMatch[1].replace(/,/g, ""));
          }
        }

        tweets.push({ text, isReply, authorIsHandle, views, likes, retweets, replies });
      }

      return { bio, tweets };
    },
    { handle },
  );

  // Score AI relevance (0-40)
  const bioAiMatch = AI_BIO_STRONG.test(data.bio);
  const ownTweets = data.tweets.filter((t) => t.authorIsHandle && !t.isReply);
  const aiTweetCount = ownTweets.filter((t) => AI_KEYWORDS.test(t.text)).length;
  const aiRatio = ownTweets.length > 0 ? aiTweetCount / ownTweets.length : 0;
  let aiScore = 0;
  if (bioAiMatch) aiScore += 20;
  aiScore += Math.min(aiRatio * 30, 20);

  // Score engagement (0-35)
  const avgViews =
    ownTweets.length > 0
      ? ownTweets.reduce((s, t) => s + t.views, 0) / ownTweets.length
      : 0;
  const avgLikes =
    ownTweets.length > 0
      ? ownTweets.reduce((s, t) => s + t.likes, 0) / ownTweets.length
      : 0;
  // Views scoring: 1k=5, 5k=15, 20k=25, 100k+=35
  let engagementScore = 0;
  if (avgViews >= 100_000) engagementScore = 35;
  else if (avgViews >= 20_000) engagementScore = 25 + ((avgViews - 20_000) / 80_000) * 10;
  else if (avgViews >= 5_000) engagementScore = 15 + ((avgViews - 5_000) / 15_000) * 10;
  else if (avgViews >= 1_000) engagementScore = 5 + ((avgViews - 1_000) / 4_000) * 10;
  else engagementScore = (avgViews / 1_000) * 5;

  // Score interactivity (0-25)
  // Look for tweets that are replies BY the handle author (they reply to others)
  const repliesByAuthor = data.tweets.filter(
    (t) => t.authorIsHandle && t.isReply,
  ).length;
  // Also check: do their tweets get many replies? (high replies = active conversation)
  const avgReplies =
    ownTweets.length > 0
      ? ownTweets.reduce((s, t) => s + t.replies, 0) / ownTweets.length
      : 0;
  let interactivityScore = 0;
  // Author replies to others (strong signal of accessibility)
  interactivityScore += Math.min(repliesByAuthor * 5, 15);
  // Their posts get many replies (active community)
  interactivityScore += Math.min((avgReplies / 20) * 10, 10);

  const total = Math.round(aiScore + engagementScore + interactivityScore);

  return {
    handle: `@${handle}`,
    bio: data.bio.slice(0, 200),
    ai_relevance: Math.round(aiScore),
    engagement: Math.round(engagementScore),
    interactivity: Math.round(interactivityScore),
    total,
    details: {
      avg_views: Math.round(avgViews),
      avg_likes: Math.round(avgLikes),
      tweet_count_sampled: ownTweets.length,
      ai_tweets_ratio: Math.round(aiRatio * 100) / 100,
      replies_by_author: repliesByAuthor,
      bio_ai_match: bioAiMatch,
    },
  };
}

async function processWorker(
  context: BrowserContext,
  handles: string[],
  workerId: number,
  results: HandleScore[],
): Promise<void> {
  let page = await context.newPage();
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    log(`[w${workerId}] ${i + 1}/${handles.length}: @${handle}`);
    try {
      const score = await evaluateHandle(page, handle);
      if (score !== null) {
        results.push(score);
      }
      // Rate-limit friendly: base delay + jitter to spread requests
      const jitter = Math.random() * 2000;
      await page.waitForTimeout(INTER_HANDLE_DELAY_MS + jitter);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("closed") || msg.includes("Target")) {
        log(`[w${workerId}] page crashed — reopening tab after cooldown`);
        try { await page.close(); } catch { /* already dead */ }
        await new Promise((r) => setTimeout(r, 5000));
        page = await context.newPage();
      }
    }
  }
  try { await page.close(); } catch { /* ok */ }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

(async () => {
  const { tier1, tier2 } = parseHandles();
  const handles = SKIP_TIER1 ? tier2 : [...tier1, ...tier2];
  const estSeconds = (handles.length / CONCURRENCY) * ((INTER_HANDLE_DELAY_MS + PER_HANDLE_MS) / 1000);
  log(`${handles.length} handles to evaluate (${CONCURRENCY} concurrent tabs, ${INTER_HANDLE_DELAY_MS}ms delay)`);
  log(`estimated time: ~${Math.ceil(estSeconds / 60)} minutes`);

  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 60_000 });
  try {
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error("No browser contexts found — is Chrome running with a profile?");
    }
    const ctx = contexts[0];
    const results: HandleScore[] = [];

    // Split handles across workers
    const chunkSize = Math.ceil(handles.length / CONCURRENCY);
    const chunks = chunkArray(handles, chunkSize);

    log(`starting ${chunks.length} workers...`);
    await Promise.all(
      chunks.map((chunk, i) => processWorker(ctx, chunk, i, results)),
    );

    // Sort by total score descending
    results.sort((a, b) => b.total - a.total);

    const output = {
      evaluated_at: new Date().toISOString(),
      total_evaluated: results.length,
      criteria: {
        ai_relevance: "Bio + tweet content AI keyword density (0-40)",
        engagement: "Average views per tweet (0-35)",
        interactivity: "Author replies to others + receives replies (0-25)",
      },
      results,
    };

    const json = JSON.stringify(output, null, 2);
    process.stdout.write(json + "\n");
    writeFileSync(OUTPUT_FILE, json + "\n", "utf-8");
    log(`results written to ${OUTPUT_FILE}`);
    log(`top 20:`);
    for (const r of results.slice(0, 20)) {
      log(
        `  ${r.handle.padEnd(20)} total=${r.total} ai=${r.ai_relevance} eng=${r.engagement} int=${r.interactivity} views=${r.details.avg_views}`,
      );
    }
  } finally {
    await browser.close().catch(() => {});
  }
})();
