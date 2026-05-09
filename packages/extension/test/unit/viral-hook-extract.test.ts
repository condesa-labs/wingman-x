import { describe, expect, it } from "vitest";
import { extractTweetsFromGraphQLResponse } from "../../src/content/viral-hook-extract.js";

const baseLegacy = {
  full_text: "Building local-first browser agents.",
  created_at: "Sat May 09 11:00:00 +0000 2026",
  favorite_count: 123,
  retweet_count: 45,
  reply_count: 6,
  bookmark_count: 7,
};

function tweet(overrides: Record<string, unknown> = {}) {
  return {
    __typename: "Tweet",
    rest_id: "1790000000000000001",
    legacy: baseLegacy,
    views: { count: "98765" },
    core: { user_results: { result: { legacy: { screen_name: "alice_ai" } } } },
    ...overrides,
  };
}

const envelope = (result: unknown) => ({ data: { x: { tweet_results: { result } } } });
const extract = (result: unknown) => extractTweetsFromGraphQLResponse(envelope(result));

describe("extractTweetsFromGraphQLResponse", () => {
  it("extracts a tweet_results.result payload", () => {
    expect(extract(tweet())).toEqual([
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

  it("extracts data when GraphQL returns an empty errors array", () => {
    expect(
      extractTweetsFromGraphQLResponse({ errors: [], ...envelope(tweet()) }),
    ).toHaveLength(1);
  });

  it("skips deleted tweets and promoted wrappers", () => {
    expect(extract({ __typename: "TweetTombstone" })).toEqual([]);
    expect(extract(tweet({ promotedMetadata: {} }))).toEqual([]);
  });

  it("unwraps retweets and extracts the original tweet", () => {
    const result = extract(
      tweet({
        legacy: {
          retweeted_status_result: {
            result: tweet({
              rest_id: "1790000000000000002",
              legacy: { ...baseLegacy, full_text: "Original post." },
            }),
          },
        },
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tweet_id: "1790000000000000002",
      tweet_text: "Original post.",
    });
  });

  it("returns empty array for error envelopes and malformed responses", () => {
    expect(extractTweetsFromGraphQLResponse({ errors: [{ message: "x" }] })).toEqual([]);
    expect(extractTweetsFromGraphQLResponse(null)).toEqual([]);
    expect(extractTweetsFromGraphQLResponse({ tweet_results: "bad" })).toEqual([]);
  });
});
