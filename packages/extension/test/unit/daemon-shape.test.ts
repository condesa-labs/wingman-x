import { describe, expect, it } from "vitest";
import {
  isDaemonCandidate,
  isDaemonCandidatesListResponse,
  isDaemonSuggestionResponse,
} from "../../src/daemon-shape.js";

const VALID_CANDIDATE = {
  id: "uuid-1",
  tweet_id: "1790000000000000001",
  tweet_url: "https://x.com/alice_ai/status/1790000000000000001",
  author_handle: "@alice_ai",
  tweet_text: "Hello, Twitter.",
  suggested_reply: "Hi Alice, great point.",
  match_reason: "matches topic",
  match_category: "topic",
  kb_refs: ["library/topic.md"],
  created_at: "2026-04-23T00:00:00.000Z",
  status: "pending",
  status_updated_at: "2026-04-23T00:00:00.000Z",
};

describe("isDaemonCandidate", () => {
  it("accepts a valid full candidate", () => {
    expect(isDaemonCandidate(VALID_CANDIDATE)).toBe(true);
  });

  it("rejects a non-object input", () => {
    expect(isDaemonCandidate(null)).toBe(false);
    expect(isDaemonCandidate(undefined)).toBe(false);
    expect(isDaemonCandidate("string")).toBe(false);
    expect(isDaemonCandidate(42)).toBe(false);
  });

  it("rejects when tweet_url is not a twitter/x status URL", () => {
    expect(
      isDaemonCandidate({ ...VALID_CANDIDATE, tweet_url: "https://evil.com/alice/status/1" }),
    ).toBe(false);
    expect(
      isDaemonCandidate({ ...VALID_CANDIDATE, tweet_url: "not-a-url" }),
    ).toBe(false);
  });

  it("rejects when status is not in the daemon's enum", () => {
    expect(
      isDaemonCandidate({ ...VALID_CANDIDATE, status: "unknown" }),
    ).toBe(false);
    expect(
      isDaemonCandidate({ ...VALID_CANDIDATE, status: "anything" }),
    ).toBe(false);
  });

  it("rejects when match_category is not in the enum", () => {
    expect(
      isDaemonCandidate({ ...VALID_CANDIDATE, match_category: "other" }),
    ).toBe(false);
  });

  it("rejects when created_at is not ISO-8601 UTC", () => {
    expect(
      isDaemonCandidate({ ...VALID_CANDIDATE, created_at: "2026-04-23" }),
    ).toBe(false);
    expect(
      isDaemonCandidate({ ...VALID_CANDIDATE, created_at: "not-a-date" }),
    ).toBe(false);
  });

  it("rejects when kb_refs is not an array of strings", () => {
    expect(
      isDaemonCandidate({ ...VALID_CANDIDATE, kb_refs: "not-array" }),
    ).toBe(false);
    expect(
      isDaemonCandidate({ ...VALID_CANDIDATE, kb_refs: [42] }),
    ).toBe(false);
  });

  it("accepts all documented status values", () => {
    for (const status of [
      "pending",
      "filled",
      "dismissed",
      "saved",
      "regen_requested",
    ]) {
      expect(
        isDaemonCandidate({ ...VALID_CANDIDATE, status }),
        `status=${status}`,
      ).toBe(true);
    }
  });
});

describe("isDaemonCandidatesListResponse", () => {
  it("accepts {candidates: [...]} with valid candidates", () => {
    expect(
      isDaemonCandidatesListResponse({ candidates: [VALID_CANDIDATE] }),
    ).toBe(true);
    expect(isDaemonCandidatesListResponse({ candidates: [] })).toBe(true);
  });

  it("rejects a shape without candidates key", () => {
    expect(isDaemonCandidatesListResponse({})).toBe(false);
    expect(isDaemonCandidatesListResponse({ items: [] })).toBe(false);
  });

  it("rejects when any candidate in the array fails the guard", () => {
    expect(
      isDaemonCandidatesListResponse({
        candidates: [VALID_CANDIDATE, { ...VALID_CANDIDATE, tweet_url: "bad" }],
      }),
    ).toBe(false);
  });

  it("rejects a squatter's lookalike response (missing required fields)", () => {
    // Peer's f13 example: a squatting service replies with
    // candidates[] where each item has only the four fields the
    // previous narrow validator checked. The new full-shape guard
    // rejects these because tweet_url doesn't match the pattern,
    // timestamps are missing, etc.
    expect(
      isDaemonCandidatesListResponse({
        candidates: [
          {
            tweet_id: "1",
            tweet_url: "not-a-tweet",
            suggested_reply: "x",
            status: "anything",
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("isDaemonSuggestionResponse", () => {
  it("accepts a valid candidate with matching tweet_id", () => {
    expect(
      isDaemonSuggestionResponse(VALID_CANDIDATE, VALID_CANDIDATE.tweet_id),
    ).toBe(true);
  });

  it("rejects when tweet_id does not echo the query", () => {
    expect(isDaemonSuggestionResponse(VALID_CANDIDATE, "different-id")).toBe(
      false,
    );
  });

  it("rejects malformed body", () => {
    expect(isDaemonSuggestionResponse(null, "1")).toBe(false);
    expect(isDaemonSuggestionResponse({}, "1")).toBe(false);
    expect(isDaemonSuggestionResponse("string", "1")).toBe(false);
  });
});
