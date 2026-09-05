import { describe, expect, it } from "vitest";
import { createFakeProvider } from "../src/llm/fake.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { draftReply, hasDashTell } from "../src/pipeline/stages/draft.js";

const post = NormalizedPostSchema.parse({
  tweet_id: "1",
  tweet_url: "https://x.com/a/status/1",
  author_handle: "a",
  tweet_text: "Tokenized stocks are just stocks.",
  created_at: "2026-09-04T00:00:00Z",
  scraped_at: "2026-09-04T00:00:00Z",
});
const base = { post, theme: "Tokenized equities", angle: "receipt vs register", chunks: [], tone: "plain", maxChars: 280 };

describe("hasDashTell", () => {
  it("catches em dashes, en dashes and spaced hyphens but not compound words", () => {
    expect(hasDashTell("a — b")).toBe(true);
    expect(hasDashTell("a – b")).toBe(true);
    expect(hasDashTell("a - b")).toBe(true);
    expect(hasDashTell("issuer-sponsored token, T+0")).toBe(false);
  });
});

describe("draftReply", () => {
  it("rewrites a draft that contains dashes and labels the retry", async () => {
    const labels: string[] = [];
    let n = 0;
    const llm = createFakeProvider(({ label, prompt }) => {
      labels.push(label);
      n += 1;
      if (n === 1) return { suggested_reply: "Registration isn't the issue — it's the register." };
      expect(prompt).toContain("<has_dashes>");
      return { suggested_reply: "Registration isn't the issue. The register is." };
    });
    const out = await draftReply({ ...base, llm });
    expect(out.suggested_reply).toBe("Registration isn't the issue. The register is.");
    expect(out.ai_tell_flags).toEqual([]);
    expect(out.attempts).toBe(2);
    expect(labels).toEqual(["draft:1", "draft:1:dashes"]);
  });

  it("flags a dash that survives the rewrite budget instead of dropping the draft", async () => {
    const llm = createFakeProvider(() => ({ suggested_reply: "Still — dashed." }));
    const out = await draftReply({ ...base, llm });
    expect(out.ai_tell_flags).toContain("dash");
    expect(out.attempts).toBe(4);
  });

  it("shortens with tightening targets and gives up after the budget", async () => {
    const prompts: string[] = [];
    const llm = createFakeProvider(({ prompt }) => {
      prompts.push(prompt);
      return { suggested_reply: "x".repeat(300) };
    });
    await expect(draftReply({ ...base, llm })).rejects.toThrow(/still exceeds 280/);
    expect(prompts[1]).toContain("under 240 characters");
    expect(prompts[2]).toContain("under 200 characters");
  });
});
