import { describe, expect, it } from "vitest";
import { computeScore } from "../src/score.js";

const now = new Date("2026-05-09T12:00:00.000Z");

function input(overrides: Partial<Parameters<typeof computeScore>[0]> = {}) {
  return {
    views: 100_000,
    likes: 5_000,
    retweets: 1_000,
    replies: 200,
    bookmarks: 500,
    created_at: "2026-05-09T11:00:00.000Z",
    ...overrides,
  };
}

describe("computeScore", () => {
  it("scores a fresh high-view tweet higher than the same old tweet", () => {
    const fresh = computeScore(input(), now);
    const old = computeScore(
      input({ created_at: "2026-05-08T12:00:00.000Z" }),
      now,
    );

    expect(fresh).toBeGreaterThan(old);
  });

  it("avoids divide-by-zero when likes are zero", () => {
    expect(
      computeScore(input({ likes: 0, retweets: 20, bookmarks: 10 }), now),
    ).toBeGreaterThanOrEqual(0);
  });

  it("clamps extreme inputs to 100", () => {
    expect(
      computeScore(
        input({
          views: 10_000_000,
          likes: 1_000_000,
          retweets: 600_000,
          replies: 100_000,
          bookmarks: 300_000,
        }),
        now,
      ),
    ).toBe(100);
  });

  it("keeps zero-view tweets below viral scores", () => {
    expect(
      computeScore(
        input({
          views: 0,
          likes: 1_000,
          retweets: 500,
          replies: 200,
          bookmarks: 300,
        }),
        now,
      ),
    ).toBeLessThanOrEqual(50);
  });
});
