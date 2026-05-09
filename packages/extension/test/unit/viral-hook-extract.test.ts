import { describe, expect, it } from "vitest";
import { extractTweetsFromGraphQLResponse } from "../../src/content/viral-hook-extract.js";

function tweet(overrides: Record<string, unknown> = {}) {
  return {
    __typename: "Tweet",
    rest_id: "1790000000000000001",
    legacy: {
      full_text: "Building local-first browser agents.",
      created_at: "Sat May 09 11:00:00 +0000 2026",
      favorite_count: 123,
      retweet_count: 45,
      reply_count: 6,
      bookmark_count: 7,
    },
    views: { count: "98765" },
    core: {
      user_results: {
        result: {
          legacy: { screen_name: "alice_ai" },
        },
      },
    },
    ...overrides,
  };
}

describe("extractTweetsFromGraphQLResponse", () => {
  it("extracts a tweet_results.result payload", () => {
    const result = extractTweetsFromGraphQLResponse({
      data: {
        home: {
          instructions: [
            {
              entries: [
                { content: { itemContent: { tweet_results: { result: tweet() } } } },
              ],
            },
          ],
        },
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        tweet_id: "1790000000000000001",
        tweet_url: "https://x.com/alice_ai/status/1790000000000000001",
        author_handle: "alice_ai",
        views: 98765,
        likes: 123,
        retweets: 45,
        replies: 6,
        bookmarks: 7,
        created_at: "2026-05-09T11:00:00.000Z",
      }),
    ]);
  });

  it("skips deleted tweet envelopes", () => {
    const result = extractTweetsFromGraphQLResponse({
      tweet_results: { result: { __typename: "TweetTombstone" } },
    });

    expect(result).toEqual([]);
  });

  it("skips promoted tweet wrappers", () => {
    const result = extractTweetsFromGraphQLResponse({
      tweet_results: {
        result: tweet({ promotedMetadata: { advertiser_results: {} } }),
      },
    });

    expect(result).toEqual([]);
  });

  it("unwraps retweets and extracts the original tweet", () => {
    const result = extractTweetsFromGraphQLResponse({
      tweet_results: {
        result: tweet({
          legacy: {
            retweeted_status_result: {
              result: tweet({
                rest_id: "1790000000000000002",
                legacy: {
                  full_text: "Original high velocity post.",
                  created_at: "Sat May 09 10:30:00 +0000 2026",
                  favorite_count: 500,
                  retweet_count: 250,
                  reply_count: 100,
                  bookmark_count: 80,
                },
              }),
            },
          },
        }),
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tweet_id: "1790000000000000002",
      tweet_text: "Original high velocity post.",
    });
  });

  it("returns empty array for GraphQL error envelopes", () => {
    expect(
      extractTweetsFromGraphQLResponse({
        errors: [{ message: "rate limited" }],
      }),
    ).toEqual([]);
  });

  it("returns empty array for malformed responses instead of throwing", () => {
    expect(extractTweetsFromGraphQLResponse(null)).toEqual([]);
    expect(extractTweetsFromGraphQLResponse({ tweet_results: "bad" })).toEqual(
      [],
    );
  });
});
