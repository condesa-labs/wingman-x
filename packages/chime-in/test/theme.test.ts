import { describe, expect, it } from "vitest";
import { createFakeProvider } from "../src/llm/fake.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { buildThemeSystemPrompt, classifyThemes } from "../src/pipeline/stages/theme.js";
import { DEFAULT_THEMES, parseThemes } from "../src/pipeline/themes.js";

const post = (id: string, text: string) =>
  NormalizedPostSchema.parse({
    tweet_id: id,
    tweet_url: `https://x.com/a/status/${id}`,
    author_handle: "a",
    tweet_text: text,
    created_at: "2026-09-04T00:00:00Z",
    scraped_at: "2026-09-04T00:00:00Z",
  });

describe("classifyThemes", () => {
  it("batches posts, retries omitted ids individually, and reports persistent failures", async () => {
    const labels: string[] = [];
    const llm = createFakeProvider(({ label, prompt }) => {
      labels.push(label);
      const ids = [...prompt.matchAll(/tweet_id="(\d+)"/g)].map((m) => m[1]!);
      // The batch answer "forgets" id 2 and 3; the retry for 2 succeeds; 3 keeps failing.
      const results = ids
        .filter((id) => id !== "3" && !(label.startsWith("theme:batch") && id === "2"))
        .map((id) => ({ tweet_id: id, relevant: id !== "4", theme: "Custody", theme_score: id === "4" ? 10 : 80, reason: "r" }));
      return { results };
    });
    const out = await classifyThemes([post("1", "a"), post("2", "b"), post("3", "c"), post("4", "d")], {
      llm,
      themes: DEFAULT_THEMES,
      batchSize: 3,
    });
    expect(out.get("1")).toEqual({ ok: true, result: { relevant: true, theme: "Custody", theme_score: 80, reason: "r" } });
    expect(out.get("2")?.ok).toBe(true);
    expect(out.get("3")).toEqual({ ok: false, error: "theme classification failed" });
    expect(out.get("4")).toMatchObject({ ok: true, result: { relevant: false } });
    expect(labels).toEqual(["theme:batch-1", "theme:retry-2", "theme:retry-3", "theme:batch-2"]);
  });

  it("treats a thrown batch as all-missing and retries each post", async () => {
    let calls = 0;
    const llm = createFakeProvider(({ label, prompt }) => {
      calls += 1;
      if (label.startsWith("theme:batch")) throw new Error("model down");
      const id = /tweet_id="(\d+)"/.exec(prompt)![1]!;
      return { results: [{ tweet_id: id, relevant: true, theme: "Fintech", theme_score: 70, reason: "ok" }] };
    });
    const out = await classifyThemes([post("1", "a"), post("2", "b")], { llm, themes: ["Fintech"], batchSize: 5 });
    expect(out.get("1")?.ok).toBe(true);
    expect(out.get("2")?.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("system prompt lists the themes and the safety boundary", () => {
    const s = buildThemeSystemPrompt(["Custody", "Settlement"]);
    expect(s).toContain("- Custody");
    expect(s).toContain("untrusted DATA");
  });

  it("parseThemes dedupes and ignores comments", () => {
    expect(parseThemes("# c\nCustody\n- custody\n\nSettlement\n")).toEqual(["Custody", "Settlement"]);
  });
});
