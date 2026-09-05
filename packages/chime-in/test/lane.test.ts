import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { DEFAULT_CONVERSATIONAL_POLICY } from "../src/kb/conversational.js";
import { conversationalEligibility, laneForTheme, nextLineType } from "../src/pipeline/lane.js";
import { buildDraftPrompt, buildDraftSystemPrompt } from "../src/pipeline/stages/draft.js";
import { buildLineSystemPrompt, LineResultSchema } from "../src/pipeline/stages/line.js";
import { buildThemeSystemPrompt } from "../src/pipeline/stages/theme.js";
import { formatMatchReason, parseAngleFromMatchReason } from "../src/wingman/candidate-map.js";
import type { NormalizedPost } from "../src/model/post.js";

const config = ConfigSchema.parse({ chimeDir: "/tmp/unused" });

const post: NormalizedPost = {
  tweet_id: "1",
  tweet_url: "https://x.com/a/status/1",
  author_handle: "a",
  author_name: "A",
  tweet_text: "every founder eventually becomes a professional calendar manager",
  created_at: "2026-09-04T00:00:00.000Z",
  reply_count: 0,
  repost_count: 0,
  like_count: 0,
  view_count: 0,
  is_reply: false,
  is_repost: false,
  is_quote: false,
  quoted_tweet: null,
  scraped_at: "2026-09-04T00:00:00.000Z",
};

describe("two lanes", () => {
  it("routes by theme, case-insensitively, expertise by default", () => {
    expect(laneForTheme("Technology and startups", config)).toBe("conversational");
    expect(laneForTheme("general and internet culture", config)).toBe("conversational");
    expect(laneForTheme("Stablecoins", config)).toBe("expertise");
    expect(laneForTheme("Regulation and policy", config)).toBe("expertise");
  });

  it("author relevance earns entry: p1 everywhere, p2 with a higher bar on strict themes, p3 never", () => {
    expect(conversationalEligibility(1, "General and internet culture", config)).toMatchObject({ eligible: true, threshold: 80 });
    expect(conversationalEligibility(2, "Technology and startups", config)).toMatchObject({ eligible: true, threshold: 80 });
    expect(conversationalEligibility(2, "General and internet culture", config)).toMatchObject({ eligible: true, threshold: 90 });
    expect(conversationalEligibility(3, "Technology and startups", config).eligible).toBe(false);
  });

  it("cycles reply types without repeating", () => {
    expect(nextLineType([])).toBe("irony");
    expect(nextLineType(["irony"])).toBe("question");
    expect(nextLineType(["question", "irony", "thinking_out_loud"])).toBe("light_reaction");
    expect(nextLineType(["irony", "question", "thinking_out_loud", "light_reaction"])).toBe("light_reaction");
  });

  it("line gate schema: energy defaults, type is closed, context is not a type", () => {
    const r = LineResultSchema.parse({ line_score: 85, line_type: "irony", line: "x", reason: "r" });
    expect(r.energy).toBe("casual");
    expect(() => LineResultSchema.parse({ line_score: 85, line_type: "context", line: "x", reason: "r" })).toThrow();
    const sys = buildLineSystemPrompt(DEFAULT_CONVERSATIONAL_POLICY, "no plugging");
    expect(sys).toContain("Match the energy");
    expect(sys).toContain("Every fact in the line comes from the post itself");
    expect(sys).toContain("no plugging");
  });

  it("theme classifier is told expertise wins on overlap, only when conversational themes are configured", () => {
    const themes = ["Stablecoins", "Technology and startups"];
    expect(buildThemeSystemPrompt(themes, ["Technology and startups"])).toContain("expertise wins on overlap");
    expect(buildThemeSystemPrompt(themes)).not.toContain("expertise wins");
    expect(buildThemeSystemPrompt(themes, ["Not a configured theme"])).not.toContain("expertise wins");
  });

  it("conversational drafting carries no KB excerpts and states energy, type, and line", () => {
    const p = buildDraftPrompt({ post, theme: "Technology and startups", angle: "the calendar is the company now", chunks: [], lane: "conversational", lineType: "irony", energy: "casual", maxChars: 280 });
    expect(p).toContain("Energy of the post: casual");
    expect(p).toContain("Reply type: irony");
    expect(p).toContain("The line: the calendar is the company now");
    expect(p).not.toContain("Knowledge base excerpts");
    expect(p).not.toContain("Move:");
    const sys = buildDraftSystemPrompt("tone", 280, "no plugging", "conversational", DEFAULT_CONVERSATIONAL_POLICY);
    expect(sys).toContain("name its energy");
    expect(sys).toContain("# Reply policy for this lane");
    expect(sys).not.toContain("Knowledge base excerpts");
    expect(buildDraftSystemPrompt("tone", 280)).toContain("Then check the excerpts");
  });

  it("match reason names the lane and still round-trips the angle", () => {
    const reason = formatMatchReason({ theme: "Technology and startups", theme_score: 70, expertise_score: 0, contribution_score: 88, contribution_angle: "the calendar is the company now", lane: "conversational", line_type: "irony", energy: "casual" });
    expect(reason.startsWith("Lane: conversational | Theme: Technology and startups (70) | Line: 88 | Type: irony | Energy: casual")).toBe(true);
    expect(parseAngleFromMatchReason(reason)).toBe("the calendar is the company now");
  });
});
