/**
 * Unit tests for `parseTweetId` — the content-script's URL parser.
 *
 * Spec CP04 requires ≥ 5 URL variants covered:
 *   (1) clean twitter.com URL
 *   (2) URL with tracking params (?s=20&t=...)
 *   (3) x.com host variant
 *   (4) twitter.com host variant
 *   (5) trailing slash
 *
 * We cover all 5 plus a few negative cases (non-numeric id, wrong host,
 * missing /status segment, localhost for the E2E fixture).
 *
 * The parser MUST:
 *   - return the numeric tweet id as a string for valid tweet-detail URLs
 *     on twitter.com / x.com / localhost (fixture host)
 *   - return null for any URL that is not a tweet-detail page
 *   - never throw on malformed input
 */
import { describe, expect, it } from "vitest";
import { parseTweetId } from "../../src/content/parse-tweet-url.js";

describe("parseTweetId — positive cases (spec's 5 required variants)", () => {
  it("(1) clean twitter.com URL returns the tweet id", () => {
    expect(parseTweetId("https://twitter.com/jack/status/20")).toBe("20");
  });

  it("(2) x.com URL with tracking params returns the tweet id", () => {
    expect(
      parseTweetId("https://x.com/elonmusk/status/1234567890?s=20&t=abc"),
    ).toBe("1234567890");
  });

  it("(3) x.com host returns the tweet id", () => {
    expect(parseTweetId("https://x.com/jack/status/20")).toBe("20");
  });

  it("(4) twitter.com with tracking params returns the tweet id", () => {
    expect(parseTweetId("https://twitter.com/jack/status/20?s=20&t=xyz")).toBe(
      "20",
    );
  });

  it("(5) trailing slash still returns the tweet id", () => {
    expect(parseTweetId("https://twitter.com/jack/status/20/")).toBe("20");
  });
});

describe("parseTweetId — additional positive coverage", () => {
  it("accepts x.com with trailing slash + tracking", () => {
    expect(parseTweetId("https://x.com/jack/status/20/?s=20")).toBe("20");
  });

  it("accepts localhost host (test harness fixture)", () => {
    // The content script matches are extended to `localhost` so the
    // Playwright E2E can serve the fixture at `/:handle/status/:id`.
    expect(parseTweetId("http://localhost:9090/jack/status/20")).toBe("20");
  });
});

describe("parseTweetId — negative cases", () => {
  it("returns null for a non-numeric id", () => {
    // Twitter ids are snowflake numerics; anything non-digit is not a
    // valid tweet id and must not be handed to the daemon.
    expect(parseTweetId("https://twitter.com/jack/status/abc")).toBeNull();
  });

  it("returns null for a wrong host", () => {
    expect(parseTweetId("https://example.com/jack/status/20")).toBeNull();
  });

  it("returns null when /status/ segment is absent", () => {
    expect(parseTweetId("https://twitter.com/jack/profile")).toBeNull();
  });

  it("returns null (does not throw) on malformed input", () => {
    expect(parseTweetId("not a url")).toBeNull();
    expect(parseTweetId("")).toBeNull();
  });
});
