import { describe, expect, it } from "vitest";
import { ContributionResultSchema } from "../src/pipeline/stages/contribution.js";
import { buildDraftPrompt, buildDraftSystemPrompt, MOVE_GUIDE } from "../src/pipeline/stages/draft.js";
import { nextRegenMove } from "../src/pipeline/regen.js";
import { chunkMarkdown } from "../src/kb/kb-index.js";
import type { NormalizedPost } from "../src/model/post.js";

const post: NormalizedPost = {
  tweet_id: "1",
  tweet_url: "https://x.com/a/status/1",
  author_handle: "a",
  author_name: "A",
  tweet_text: "we launched fixed term lending today",
  created_at: "2026-09-04T00:00:00.000Z",
  reply_count: 0,
  repost_count: 0,
  like_count: 0,
  view_count: 0,
  is_reply: false,
  is_repost: false,
  scraped_at: "2026-09-04T00:00:00.000Z",
};

const chunk = { ref: "library/credit.md#duration", file: "library/credit.md", heading: "Duration", text: "Real credit has a date." };

describe("response policy: moves, depth, posture", () => {
  it("contribution result defaults keep older fakes valid", () => {
    const r = ContributionResultSchema.parse({ contribution_score: 70, contribution_angle: "a", reason: "r" });
    expect(r.move).toBe("agree_extend");
    expect(r.depth).toBe("substantive");
    expect(r.posture).toBe("other");
    expect(() => ContributionResultSchema.parse({ contribution_score: 70, contribution_angle: "a", reason: "r", move: "dunk" })).toThrow();
  });

  it("draft prompt puts the post first and the KB last, and carries move, depth and posture", () => {
    const p = buildDraftPrompt({
      post,
      theme: "Credit and collateral",
      angle: "ask how rollover works near maturity",
      chunks: [chunk],
      move: "question",
      depth: "light",
      posture: "announcement",
      maxChars: 280,
    });
    expect(p.indexOf("<post")).toBeLessThan(p.indexOf("Knowledge base excerpts"));
    expect(p).toContain("What the author is doing: announcement");
    expect(p).toContain(`Move: ${MOVE_GUIDE.question}`);
    expect(p).toContain("Depth: light");
    expect(p).toContain("What the reply should say: ask how rollover works near maturity");
    expect(p).toContain("grounding only");
    expect(p).not.toContain("same move");
  });

  it("a shared nearby move is a soft nudge on construction, not an instruction to change the move", () => {
    const p = buildDraftPrompt({ post, theme: "t", angle: "a", chunks: [], move: "question", avoidMoves: ["question"], maxChars: 280 });
    expect(p).toContain("Keep the move if it is the right one");
  });

  it("system prompt orders reaction before KB and forbids mining frameworks", () => {
    const s = buildDraftSystemPrompt("tone", 280);
    expect(s.indexOf("1. Read the post")).toBeLessThan(s.indexOf("3. Then check the excerpts"));
    expect(s).toContain("must not be mined for a clever framework");
    expect(s).toContain("not its syntax");
  });

  it("regen keeps the move on the first regeneration and switches from the second", () => {
    expect(nextRegenMove([])).toBe("agree_extend");
    expect(nextRegenMove(["distinction"])).toBe("distinction");
    expect(nextRegenMove(["distinction", "distinction"])).toBe("agree_extend");
    expect(nextRegenMove(["agree_extend", "agree_extend"])).toBe("question");
    expect(nextRegenMove(["agree_extend", "question", "example", "distinction", "light_reaction", "challenge", "operator_context"])).toBe(
      "agree_extend",
    );
  });

  it("KB angle sections are kept in the file but excluded from retrieval", () => {
    const chunks = chunkMarkdown({
      id: "stablecoins",
      title: "Stablecoins",
      markdown: [
        "# Stablecoins",
        "",
        "## What I believe",
        "Par is credible only because of what stands behind it.",
        "",
        "## Good reply angles",
        "- Someone says stablecoins are the settlement layer; ask what the money leg is.",
        "",
        "## Relevance cues (recognition notes)",
        "- A launch treated as if issuance were the hard part.",
        "",
        "## Boundaries and nuance",
        "No issuer figures from memory.",
      ].join("\n"),
    });
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain("What I believe");
    expect(headings).toContain("Boundaries and nuance");
    expect(headings.some((h) => /reply angles|relevance cues/i.test(h))).toBe(false);
  });
});
