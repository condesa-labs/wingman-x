import { describe, expect, it } from "vitest";
import type { Candidate, CandidateInput } from "@wingman-x/agent-kit";
import { ConfigSchema } from "../src/config.js";
import { buildKBIndexFromDocs } from "../src/kb/kb-index.js";
import { createFakeProvider } from "../src/llm/fake.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { pendingRegens, runRegen } from "../src/pipeline/regen.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";
import { silentLogger } from "../src/util/logger.js";

const config = ConfigSchema.parse({ chimeDir: "/tmp/unused" });
const kb = buildKBIndexFromDocs("tone", [
  { id: "custody", title: "Custody", markdown: "# Custody\n\n## Control\nControl agreements decide what a lender can enforce.\n" },
]);

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: "chime-1",
  tweet_id: "1",
  tweet_url: "https://x.com/a/status/1",
  author_handle: "@a",
  tweet_text: "Custody is solved.",
  suggested_reply: "first draft",
  match_reason: "Theme: Custody (80) | Expertise: 80 | Contribution: 80 | Angle: Custody is not solved for securities.",
  match_category: "topic",
  source: "handles",
  kb_refs: ["library/custody.md", "tone.md"],
  created_at: "2026-09-04T00:00:00.000Z",
  status: "regen_requested",
  status_updated_at: "2026-09-04T01:00:00.000Z",
  ...over,
});

describe("pendingRegens", () => {
  it("selects only our regen_requested candidates not yet served for that click", () => {
    const state = { regen_handled: { "2": "2026-09-04T01:00:00.000Z" } };
    const list = [
      candidate(),
      candidate({ tweet_id: "2", id: "chime-2" }),
      candidate({ tweet_id: "3", id: "chime-3", status: "pending" }),
      candidate({ tweet_id: "4", id: "other-4" }),
    ];
    expect(pendingRegens(list, state).map((c) => c.tweet_id)).toEqual(["1"]);
  });
});

describe("runRegen", () => {
  it("redrafts with prior replies, re-POSTs preserving fields, and records the served click", async () => {
    const posted: CandidateInput[] = [];
    const prompts: string[] = [];
    const llm = createFakeProvider(({ prompt, tier }) => {
      prompts.push(prompt);
      expect(tier).toBe("draft");
      return { suggested_reply: "a meaningfully different draft" };
    });
    const state = { regen_handled: {} as Record<string, string> };
    const log = createMemoryCandidateLog();
    const summary = await runRegen({
      config,
      llm,
      kb,
      candidateLog: log,
      state,
      getCandidates: async () => [candidate()],
      postCandidates: async (cs) => { posted.push(...cs); return { accepted: cs.length }; },
      log: silentLogger,
    });
    expect(summary).toEqual({ requested: 1, regenerated: 1, failed: 0, already_served: 0, served_from_alternates: 0, fills_recorded: 0 });
    expect(posted[0]).toMatchObject({ id: "chime-1", suggested_reply: "A meaningfully different draft", match_reason: candidate().match_reason, kb_refs: ["library/custody.md", "tone.md"] });
    expect(prompts[0]).toContain("<rejected_draft n=\"1\">\nfirst draft");
    expect(prompts[0]).toContain("What the reply should say: Custody is not solved for securities.");
    expect(prompts[0]).toContain("library/custody.md#control");
    expect(state.regen_handled["1"]).toBe("2026-09-04T01:00:00.000Z");

    // Same click again → nothing to do.
    const again = await runRegen({ config, llm, kb, candidateLog: log, state, getCandidates: async () => [candidate()], postCandidates: async () => { throw new Error("should not post"); }, log: silentLogger });
    expect(again.requested).toBe(0);
    expect(again.already_served).toBe(1);
    // --force redrafts the same click again.
    const forced = await runRegen({ config, llm, kb, candidateLog: log, state, getCandidates: async () => [candidate()], postCandidates: async (cs) => ({ accepted: cs.length }), log: silentLogger, force: true });
    expect(forced.requested).toBe(1);
    expect(forced.regenerated).toBe(1);
  });

  it("uses the candidate log when present and counts failures without throwing", async () => {
    const log = createMemoryCandidateLog();
    log.upsert({
      tweet_id: "1",
      recorded_at: "x",
      post: NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: "Custody is solved.", created_at: "2026-09-04T00:00:00Z", scraped_at: "2026-09-04T00:00:00Z" }),
      theme: "Custody",
      theme_score: 80,
      expertise_score: 80,
      contribution_score: 80,
      contribution_angle: "logged angle",
      account_priority: 2,
      kb_refs: ["library/custody.md"],
      chunk_refs: ["library/custody.md#control"],
      replies: ["first draft"],
    });
    const prompts: string[] = [];
    const llm = createFakeProvider(({ prompt }) => { prompts.push(prompt); throw new Error("model down"); });
    const state = { regen_handled: {} };
    const summary = await runRegen({ config, llm, kb, candidateLog: log, state, getCandidates: async () => [candidate()], postCandidates: async (cs) => ({ accepted: cs.length }), log: silentLogger });
    expect(summary).toEqual({ requested: 1, regenerated: 0, failed: 1, already_served: 0, served_from_alternates: 0, fills_recorded: 0 });
    expect(prompts[0]).toContain("What the reply should say: logged angle");
    expect(state.regen_handled).toEqual({});
  });
});
