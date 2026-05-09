import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { setupTempStateDir } from "./helpers/tmpState.js";

describe("tweet pool endpoints", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let ctx: ReturnType<typeof setupTempStateDir>;
  const now = new Date("2026-05-09T12:00:00.000Z");

  beforeEach(() => {
    ctx = setupTempStateDir();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    ctx.cleanup();
  });

  it("stores observed tweets and returns top entries sorted by score", async () => {
    app = await buildServer({ now: () => now });

    const post = await app.inject({
      method: "POST",
      url: "/tweets/observed",
      payload: {
        tweets: [
          sampleObserved({ tweet_id: "low", views: 1_000 }),
          sampleObserved({ tweet_id: "high", views: 200_000 }),
          sampleObserved({ tweet_id: "mid", views: 50_000 }),
        ],
      },
    });

    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual({ stored: 3 });

    const get = await app.inject({
      method: "GET",
      url: "/tweet_pool/top?limit=2&min_score=0",
    });

    expect(get.statusCode).toBe(200);
    const body = get.json() as { tweets: Array<Record<string, unknown>> };
    expect(body.tweets.map((t) => t.tweet_id)).toEqual(["high", "mid"]);
    expect(body.tweets[0]).toMatchObject({
      views: 200_000,
      observed_at: now.toISOString(),
    });
  });

  it("replaces existing tweet ids with latest observations", async () => {
    app = await buildServer({ now: () => now });

    await app.inject({
      method: "POST",
      url: "/tweets/observed",
      payload: { tweets: [sampleObserved({ tweet_id: "same", views: 10 })] },
    });
    const second = await app.inject({
      method: "POST",
      url: "/tweets/observed",
      payload: { tweets: [sampleObserved({ tweet_id: "same", views: 5000 })] },
    });

    expect(second.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/tweet_pool/top" });
    expect(get.json().tweets).toHaveLength(1);
    expect(get.json().tweets[0].views).toBe(5000);
  });

  it("filters by min_score and caps limit to 100", async () => {
    app = await buildServer({ now: () => now });

    await app.inject({
      method: "POST",
      url: "/tweets/observed",
      payload: {
        tweets: Array.from({ length: 120 }, (_, i) =>
          sampleObserved({ tweet_id: `tweet-${i}`, views: 200_000 + i }),
        ),
      },
    });

    const get = await app.inject({
      method: "GET",
      url: "/tweet_pool/top?limit=500&min_score=30",
    });

    expect(get.statusCode).toBe(200);
    expect(get.json().tweets.length).toBe(100);
    expect(
      get.json().tweets.every((t: Record<string, unknown>) => Number(t.score) >= 30),
    ).toBe(true);
  });

  it("evicts entries older than 24h and drops lowest-score entries beyond capacity", async () => {
    app = await buildServer({ now: () => now });

    const tweets = [
      sampleObserved({
        tweet_id: "expired",
        views: 1_000_000,
        created_at: "2026-05-07T00:00:00.000Z",
      }),
      ...Array.from({ length: 1005 }, (_, i) =>
        sampleObserved({
          tweet_id: `bulk-${i}`,
          views: i,
          created_at: "2026-05-09T11:00:00.000Z",
        }),
      ),
    ];

    const res = await app.inject({
      method: "POST",
      url: "/tweets/observed",
      payload: { tweets },
    });

    expect(res.statusCode).toBe(200);
    const state = JSON.parse(readFileSync(ctx.statePath, "utf8"));
    const ids = Object.keys(state.tweet_pool);
    expect(ids).toHaveLength(1000);
    expect(ids).not.toContain("expired");
    expect(ids).not.toContain("bulk-0");
  });

  it("runs eviction once per batch POST", async () => {
    let evictionRuns = 0;
    app = await buildServer({
      now: () => now,
      onTweetPoolEviction: () => {
        evictionRuns += 1;
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/tweets/observed",
      payload: {
        tweets: Array.from({ length: 50 }, (_, i) =>
          sampleObserved({ tweet_id: `batch-${i}`, views: 1000 + i }),
        ),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(evictionRuns).toBe(1);
  });

  it("rejects malformed POST bodies with details", async () => {
    app = await buildServer({ now: () => now });

    const res = await app.inject({
      method: "POST",
      url: "/tweets/observed",
      payload: { tweets: [{ tweet_id: "bad" }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(Array.isArray(res.json().details)).toBe(true);
  });
});

function sampleObserved(overrides: Partial<Record<string, unknown>> = {}) {
  const tweetId = String(overrides.tweet_id ?? "1790000000000000001");
  return {
    tweet_id: tweetId,
    tweet_url: `https://x.com/alice_ai/status/${tweetId.replace(/\D/g, "") || "1"}`,
    author_handle: "alice_ai",
    tweet_text: "A useful local-first agent note.",
    views: 10_000,
    likes: 500,
    retweets: 100,
    replies: 20,
    bookmarks: 50,
    created_at: "2026-05-09T11:00:00.000Z",
    ...overrides,
  };
}
