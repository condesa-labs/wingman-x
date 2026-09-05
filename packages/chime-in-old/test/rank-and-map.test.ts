import { describe, expect, it } from "vitest";
import { CandidateInputSchema } from "@wingman-x/agent-kit";
import { NormalizedPostSchema } from "../src/model/post.js";
import { priorityAdjustment, rankCandidates, rankScore } from "../src/pipeline/rank.js";
import { formatMatchReason, parseAngleFromMatchReason, toWingmanCandidate } from "../src/wingman/candidate-map.js";

const item = (id: string, contribution: number, expertise: number, priority: 1 | 2 | 3, created = "2026-09-04T00:00:00Z") => ({
  tweet_id: id,
  theme_score: 80,
  expertise_score: expertise,
  contribution_score: contribution,
  account_priority: priority,
  created_at: created,
});

describe("rankCandidates", () => {
  it("orders by contribution first, expertise second, with priority nudges, and applies the cap", () => {
    const { selected, rankedOut } = rankCandidates(
      [item("a", 80, 90, 2), item("b", 88, 70, 2), item("c", 80, 90, 1), item("d", 80, 90, 3)],
      { priorityBoost: 5, max: 3 },
    );
    // c: 80 + 45 + 8 + 5 = 138 · a: 133 · b: 88 + 35 + 8 = 131 · d: 128
    expect(selected.map((s) => s.tweet_id)).toEqual(["c", "a", "b"]);
    expect(rankedOut.map((s) => s.tweet_id)).toEqual(["d"]);
  });

  it("breaks exact ties by recency then id", () => {
    const { selected } = rankCandidates(
      [item("z", 80, 80, 2, "2026-09-01T00:00:00Z"), item("y", 80, 80, 2, "2026-09-03T00:00:00Z"), item("x", 80, 80, 2, "2026-09-03T00:00:00Z")],
      { priorityBoost: 5, max: 10 },
    );
    expect(selected.map((s) => s.tweet_id)).toEqual(["x", "y", "z"]);
  });

  it("a cap of zero yields no candidates (zero is a valid result)", () => {
    expect(rankCandidates([item("a", 99, 99, 1)], { priorityBoost: 5, max: 0 }).selected).toEqual([]);
  });

  it("priorityAdjustment and rankScore", () => {
    expect(priorityAdjustment(1, 5)).toBe(5);
    expect(priorityAdjustment(2, 5)).toBe(0);
    expect(priorityAdjustment(3, 5)).toBe(-5);
    expect(rankScore(item("a", 80, 60, 1), 5)).toBe(80 + 30 + 8 + 5);
  });
});

describe("toWingmanCandidate", () => {
  const post = NormalizedPostSchema.parse({
    tweet_id: "2001000000000000001",
    tweet_url: "https://x.com/creditpm/status/2001000000000000001",
    author_handle: "creditpm",
    tweet_text: "Hot take",
    created_at: "2026-09-03T15:10:00.000Z",
    scraped_at: "2026-09-04T00:00:00.000Z",
  });
  const scored = {
    post,
    theme: "Private credit",
    theme_score: 91,
    expertise_score: 94,
    contribution_score: 87,
    contribution_angle: "Challenges the assumption that secondary liquidity is the first bottleneck.",
    account_priority: 1 as const,
    kb_files: ["library/private-credit.md", "library/private-credit.md", "library/custody.md"],
    suggested_reply: "Financing utility comes first.",
    ai_tell_flags: [] as string[],
  };

  it("produces a schema-valid Wingman CandidateInput with reasoning in match_reason", () => {
    const c = toWingmanCandidate(scored);
    expect(CandidateInputSchema.safeParse(c).success).toBe(true);
    expect(c).toMatchObject({
      id: "chime-2001000000000000001",
      tweet_id: "2001000000000000001",
      author_handle: "@creditpm",
      match_category: "selected",
      source: "handles",
      kb_refs: ["library/private-credit.md", "library/custody.md", "tone.md"],
    });
    expect(c.match_reason).toBe(
      "Theme: Private credit (91) | Expertise: 94 | Contribution: 87 | Angle: Challenges the assumption that secondary liquidity is the first bottleneck.",
    );
    expect("ai_tell_flags" in c).toBe(false);
  });

  it("uses topic category for non-priority accounts and passes ai_tell_flags through", () => {
    const c = toWingmanCandidate({ ...scored, account_priority: 2, ai_tell_flags: ["canned-opening"] });
    expect(c.match_category).toBe("topic");
    expect(c.ai_tell_flags).toEqual(["canned-opening"]);
  });

  it("formatMatchReason / parseAngleFromMatchReason round-trip", () => {
    const reason = formatMatchReason(scored);
    expect(parseAngleFromMatchReason(reason)).toBe(scored.contribution_angle);
    expect(parseAngleFromMatchReason("no angle here")).toBeNull();
  });
});
