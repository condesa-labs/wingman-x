import { describe, expect, it } from "vitest";
import { NormalizedPostSchema, type NormalizedPost } from "../src/model/post.js";
import { isPromotionalSpam, mechanicalFilter, stripUrlsAndMentions } from "../src/pipeline/stages/mechanical.js";

function post(overrides: Partial<NormalizedPost> & { tweet_text: string }): NormalizedPost {
  return NormalizedPostSchema.parse({
    tweet_id: "1",
    tweet_url: "https://x.com/a/status/1",
    author_handle: "a",
    created_at: "2026-09-04T00:00:00Z",
    scraped_at: "2026-09-04T00:00:00Z",
    ...overrides,
  });
}

const base = { includeReplies: false, includeReposts: false, seen: () => false };

describe("mechanicalFilter", () => {
  it("passes an ordinary substantive post", () => {
    expect(mechanicalFilter(post({ tweet_text: "Tokenized credit needs financing utility before liquidity." }), base)).toEqual({ pass: true });
  });

  it("drops seen, reposts and replies by default, but can include replies/reposts", () => {
    expect(mechanicalFilter(post({ tweet_text: "x".repeat(40) }), { ...base, seen: () => true })).toEqual({ pass: false, reason: "seen" });
    expect(mechanicalFilter(post({ tweet_text: "RT @b: something long enough", is_repost: true }), base)).toEqual({ pass: false, reason: "repost" });
    expect(mechanicalFilter(post({ tweet_text: "@b agreed on all the points you made", is_reply: true }), base)).toEqual({ pass: false, reason: "reply" });
    expect(mechanicalFilter(post({ tweet_text: "@b agreed on all the points you made", is_reply: true }), { ...base, includeReplies: true })).toEqual({ pass: true });
    expect(mechanicalFilter(post({ tweet_text: "RT @b: something long enough", is_repost: true }), { ...base, includeReposts: true })).toEqual({ pass: true });
  });

  it("drops empty / link-only posts unless the quoted tweet carries the content", () => {
    expect(mechanicalFilter(post({ tweet_text: "https://t.co/abc @x" }), base)).toEqual({ pass: false, reason: "empty" });
    expect(mechanicalFilter(post({ tweet_text: "this", quoted_tweet: { text: "A substantive quoted argument about custody." } }), base)).toEqual({ pass: true });
  });

  it("drops obvious promotional spam", () => {
    expect(mechanicalFilter(post({ tweet_text: "GIVEAWAY: join my telegram for the airdrop, whitelist closes tonight" }), base)).toEqual({ pass: false, reason: "spam" });
    expect(isPromotionalSpam("great alpha #a #b #c #d")).toBe(true);
    expect(isPromotionalSpam("$ABC $DEF $GHI to the moon")).toBe(true);
    expect(isPromotionalSpam("🚀🚀🚀🔥🔥 wen moon")).toBe(true);
    expect(isPromotionalSpam("We closed a $40m warehouse facility; details on the borrowing base below.")).toBe(false);
  });

  it("stripUrlsAndMentions removes urls and @mentions", () => {
    expect(stripUrlsAndMentions("hi @bob see https://x.com/a and  more")).toBe("hi see and more");
  });
});
