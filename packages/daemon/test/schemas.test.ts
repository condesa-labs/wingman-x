import { describe, expect, it } from "vitest";
import {
  ObservedTweetInputSchema,
  ObservedTweetSchema,
  StateFileSchema,
} from "../src/schemas.js";

describe("viral tweet schemas", () => {
  const observedInput = {
    tweet_id: "1790000000000000000",
    tweet_url: "https://x.com/example/status/1790000000000000000",
    author_handle: "example",
    tweet_text: "Shipping a local-first agent loop.",
    views: 1000,
    likes: 50,
    retweets: 10,
    replies: 3,
    bookmarks: 5,
    created_at: "2026-05-09T12:00:00.000Z",
  };

  it("accepts observed tweet input and rejects invalid created_at", () => {
    expect(ObservedTweetInputSchema.parse(observedInput)).toMatchObject({
      tweet_id: observedInput.tweet_id,
      views: observedInput.views,
    });

    expect(() =>
      ObservedTweetInputSchema.parse({
        ...observedInput,
        created_at: "not-a-date",
      }),
    ).toThrow();
  });

  it("extends persisted observed tweets with observed_at and score", () => {
    expect(
      ObservedTweetSchema.parse({
        ...observedInput,
        observed_at: "2026-05-09T12:01:00.000Z",
        score: 42,
      }),
    ).toMatchObject({ score: 42 });
  });

  it("defaults tweet_pool on state files", () => {
    expect(StateFileSchema.parse({ candidates: {}, signals: {} }).tweet_pool)
      .toEqual({});
  });
});
