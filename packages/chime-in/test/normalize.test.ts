import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeApifyItem, normalizeApifyItems } from "../src/sources/apify/normalize.js";

const items = JSON.parse(readFileSync(resolve(__dirname, "fixtures/apify-items.json"), "utf8")) as unknown[];
const NOW = "2026-09-04T12:00:00.000Z";

describe("normalizeApifyItem", () => {
  it("maps an apidojo tweet with Twitter-format createdAt and nested author", () => {
    const p = normalizeApifyItem(items[0], NOW);
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      tweet_id: "2001000000000000001",
      tweet_url: "https://x.com/creditpm/status/2001000000000000001",
      author_handle: "creditpm",
      author_name: "Credit PM",
      reply_count: 9,
      repost_count: 12,
      like_count: 140,
      view_count: 15400,
      is_reply: false,
      is_repost: false,
      is_quote: false,
      lang: "en",
      scraped_at: NOW,
    });
    expect(p?.created_at).toBe("2026-09-03T15:10:00.000Z");
    expect(p?.quoted_tweet).toBeNull();
  });

  it("captures quoted tweets", () => {
    const p = normalizeApifyItem(items[1], NOW);
    expect(p?.is_quote).toBe(true);
    expect(p?.quoted_tweet).toEqual({
      tweet_id: "2000000000000000099",
      author_handle: "ledgerfan",
      text: "Shared ledgers will make T+0 the default.",
    });
  });

  it("flags replies via isReply and reposts via isRetweet / RT prefix", () => {
    expect(normalizeApifyItem(items[2], NOW)?.is_reply).toBe(true);
    expect(normalizeApifyItem(items[3], NOW)?.is_repost).toBe(true);
    const inferred = normalizeApifyItem(
      { id: "1", url: "https://x.com/a/status/1", text: "RT @b: hi there", author: { userName: "a" } },
      NOW,
    );
    expect(inferred?.is_repost).toBe(true);
  });

  it("drops apidojo mock_tweet padding and garbage", () => {
    expect(normalizeApifyItem(items[7], NOW)).toBeNull();
    expect(normalizeApifyItem(null, NOW)).toBeNull();
    expect(normalizeApifyItem("str", NOW)).toBeNull();
    expect(normalizeApifyItem({ text: "no id, no handle" }, NOW)).toBeNull();
  });

  it("maps a simple feed-scraper shape, deriving the id from the url and parsing string counts", () => {
    const p = normalizeApifyItem(items[8], NOW);
    expect(p).toMatchObject({
      tweet_id: "2001000000000000008",
      author_handle: "feedbot",
      like_count: 1200,
      repost_count: 3,
      reply_count: 1,
      created_at: "2026-09-03T20:00:00.000Z",
    });
  });

  it("builds a canonical x.com url when the item has no url, and falls back to scraped_at for bad dates", () => {
    const p = normalizeApifyItem({ id_str: "42", full_text: "hello world", user: { screen_name: "Bob" }, created_at: "not a date" }, NOW);
    expect(p?.tweet_url).toBe("https://x.com/Bob/status/42");
    expect(p?.created_at).toBe(NOW);
  });

  it("maps the delicious_zebu flat shape (tweetId, tweetUrl, authorHandle, space-separated date, flat quote)", () => {
    const p = normalizeApifyItem(
      {
        tweetId: "2095965466883760400",
        tweetUrl: "https://x.com/sytaylor/status/2095965466883760400",
        createdAt: "2026-09-04 20:01:23+00:00",
        fullText: "C'mon people. This is clever framing for clicks.",
        replyCount: 4,
        repostCount: 2,
        retweetCount: 1,
        likeCount: 30,
        viewCount: 5000,
        isReply: false,
        isRetweet: false,
        isQuote: true,
        quotedTweetId: "2095900000000000000",
        quotedText: "Anthropic builds its own billing.",
        quotedAuthorHandle: "theinformation",
        authorName: "Simon Taylor",
        authorHandle: "sytaylor",
      },
      NOW,
    );
    expect(p).toMatchObject({
      tweet_id: "2095965466883760400",
      author_handle: "sytaylor",
      author_name: "Simon Taylor",
      created_at: "2026-09-04T20:01:23.000Z",
      reply_count: 4,
      repost_count: 1,
      like_count: 30,
      view_count: 5000,
      is_quote: true,
      quoted_tweet: { tweet_id: "2095900000000000000", author_handle: "theinformation", text: "Anthropic builds its own billing." },
    });
  });

  it("normalizeApifyItems dedupes by tweet_id and skips nulls", () => {
    const list = normalizeApifyItems([...items, items[0]], NOW);
    const ids = list.map((p) => p.tweet_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("2001000000000000001");
    expect(ids).not.toContain("-1");
    expect(list.length).toBe(8);
  });
});
