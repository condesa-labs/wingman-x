import { describe, expect, it } from "vitest";
import {
  CandidateInputSchema,
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

describe("CandidateInputSchema: ai_tell_flags", () => {
  const TWEET_ID = "1790000000000000004";
  const baseInput = {
    id: "uuid-cp01-daemon-1",
    tweet_id: TWEET_ID,
    tweet_url: `https://x.com/dave_io/status/${TWEET_ID}`,
    author_handle: "@dave_io",
    tweet_text: "daemon contract test tweet",
    suggested_reply: "daemon contract test reply",
    match_reason: "test",
    match_category: "topic" as const,
  };

  it("accepts and preserves ai_tell_flags when present", () => {
    const parsed = CandidateInputSchema.parse({
      ...baseInput,
      ai_tell_flags: ["里程碑"],
    });
    expect(parsed.ai_tell_flags).toEqual(["里程碑"]);
  });

  it("is optional — a candidate without ai_tell_flags still parses", () => {
    const parsed = CandidateInputSchema.parse(baseInput);
    expect(parsed.ai_tell_flags).toBeUndefined();
  });

  it("rejects a non-array ai_tell_flags", () => {
    expect(() =>
      CandidateInputSchema.parse({ ...baseInput, ai_tell_flags: "x" }),
    ).toThrow();
  });
});
