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
  is_quote: false,
  quoted_tweet: null,
  scraped_at: "2026-09-04T00:00:00.000Z",
};

const chunk = { ref: "library/credit.md#duration", file: "library/credit.md", title: "Credit", heading: "Duration", text: "Real credit has a date." };

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

import { draftReply, hasConcedeOpener, toSentenceCase } from "../src/pipeline/stages/draft.js";
import { createFakeProvider } from "../src/llm/fake.js";

describe("register: sentence case and concede openers", () => {
  it("capitalises sentence starts and the pronoun I, nothing else", () => {
    expect(toSentenceCase("he's right on the mint, wrong on the flow. buy pressure never reaches the share")).toBe(
      "He's right on the mint, wrong on the flow. Buy pressure never reaches the share",
    );
    expect(toSentenceCase("fwiw i think i'd separate two things, i've seen it")).toBe("Fwiw I think I'd separate two things, I've seen it");
    expect(toSentenceCase("robinhood's docs and $mstr stay as written. so dumb")).toBe("Robinhood's docs and $mstr stay as written. So dumb");
    expect(toSentenceCase("Already fine. Leave it")).toBe("Already fine. Leave it");
    expect(toSentenceCase("what happens to the yield? nobody says")).toBe("What happens to the yield? Nobody says");
  });

  it("detects concede-then-pivot openers", () => {
    expect(hasConcedeOpener("Agree on the direction, though the middle case gets flattened")).toBe(true);
    expect(hasConcedeOpener("fair, the legal read is right")).toBe(true);
    expect(hasConcedeOpener("Yes, and 24/7 access is the easy part")).toBe(true);
    expect(hasConcedeOpener("The token isn't the register")).toBe(false);
    expect(hasConcedeOpener("Agreement alone is not a reply")).toBe(false);
  });

  it("asks for one opener rewrite when a nearby reply already conceded, and sentence-cases the result", async () => {
    const seen: string[] = [];
    const llm = createFakeProvider(({ prompt }) => {
      seen.push(prompt);
      return prompt.includes("<concede_opener>")
        ? { suggested_reply: "the middle case gets flattened here, an entitlement passes votes only if the docs say so" }
        : { suggested_reply: "agree on the direction, though the middle case gets flattened here" };
    });
    const out = await draftReply({ post, theme: "t", angle: "a", chunks: [], tone: "tone", maxChars: 280, avoidConcedeOpener: true, llm });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("Do not open that way here");
    expect(out.suggested_reply).toBe("The middle case gets flattened here, an entitlement passes votes only if the docs say so");
  });

  it("leaves a concede opener alone when nothing nearby used one", async () => {
    let calls = 0;
    const llm = createFakeProvider(() => {
      calls += 1;
      return { suggested_reply: "agree on the direction, though the middle case gets flattened here" };
    });
    const out = await draftReply({ post, theme: "t", angle: "a", chunks: [], tone: "tone", maxChars: 280, llm });
    expect(calls).toBe(1);
    expect(out.suggested_reply.startsWith("Agree on the direction")).toBe(true);
  });
});

describe("length variety", () => {
  it("renders the short nudge only when asked", () => {
    const base = { post, theme: "t", angle: "a", chunks: [], maxChars: 280 };
    expect(buildDraftPrompt(base)).not.toContain("Make this one SHORT");
    expect(buildDraftPrompt({ ...base, lengthNudge: "short" })).toContain("Make this one SHORT");
  });
});
