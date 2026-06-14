import { describe, expect, it } from "vitest";
import {
  CandidateInputSchema,
  CandidateSchema,
} from "../src/index.js";

/**
 * CP01: the Candidate contract carries an optional `ai_tell_flags?: string[]`.
 *
 * The detector (CP02) is the sole producer; this checkpoint only widens the
 * shared zod contract so the field flows through the daemon round-trip and is
 * surfaced to readers (CP03/CP04). These assertions pin three invariants:
 *   1. a candidate carrying `ai_tell_flags` parses and the value is preserved;
 *   2. a candidate WITHOUT the field still parses (proves it is optional);
 *   3. a non-array `ai_tell_flags` is rejected (proves it is `string[]`).
 */

const TWEET_ID = "1790000000000000003";

const baseInput = {
  id: "uuid-cp01-1",
  tweet_id: TWEET_ID,
  tweet_url: `https://x.com/carol_ai/status/${TWEET_ID}`,
  author_handle: "@carol_ai",
  tweet_text: "candidate contract test tweet",
  suggested_reply: "candidate contract test reply",
  match_reason: "test",
  match_category: "topic" as const,
};

describe("CandidateInputSchema: ai_tell_flags", () => {
  it("accepts and preserves ai_tell_flags when present", () => {
    const parsed = CandidateInputSchema.parse({
      ...baseInput,
      ai_tell_flags: ["里程碑"],
    });
    expect(parsed.ai_tell_flags).toEqual(["里程碑"]);
  });

  it("is optional — a candidate without ai_tell_flags still parses", () => {
    const parsed = CandidateInputSchema.parse(baseInput);
    expect(parsed.ai_tell_flags).toBeUndefined();
  });

  it("rejects a non-array ai_tell_flags", () => {
    expect(() =>
      CandidateInputSchema.parse({ ...baseInput, ai_tell_flags: "x" }),
    ).toThrow();
  });
});

describe("CandidateSchema: ai_tell_flags round-trips", () => {
  const fullRecord = {
    ...baseInput,
    kb_refs: [],
    created_at: "2026-06-14T12:00:00.000Z",
    status: "pending" as const,
    status_updated_at: "2026-06-14T12:00:00.000Z",
    ai_tell_flags: ["里程碑", "划时代"],
  };

  it("preserves ai_tell_flags through the fully-formed record", () => {
    const parsed = CandidateSchema.parse(fullRecord);
    expect(parsed.ai_tell_flags).toEqual(["里程碑", "划时代"]);
  });

  it("parses a fully-formed record without ai_tell_flags", () => {
    const { ai_tell_flags: _omit, ...withoutFlags } = fullRecord;
    const parsed = CandidateSchema.parse(withoutFlags);
    expect(parsed.ai_tell_flags).toBeUndefined();
  });
});
