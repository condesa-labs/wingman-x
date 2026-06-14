import { describe, expect, it } from "vitest";

/**
 * humanizer-digest-core tests — the PURE aggregation/render logic for the
 * human-run feedback digest (CP04). The thin script
 * (`scripts/humanizer-digest.ts`) is I/O glue and lives outside coverage; ALL
 * branchy logic is exercised here:
 *   - empty / whitespace-only input  → "nothing flagged" digest
 *   - multi-line input               → correct per-pattern counts + examples
 *   - malformed / blank JSONL lines  → skipped (not fatal), valid lines around
 *                                      them still aggregate
 */

import {
  parseFlaggedReplies,
  aggregateByPattern,
  renderDigest,
  type FlaggedDigestRecord,
} from "../src/humanizer-digest-core.js";

function line(rec: Partial<FlaggedDigestRecord>): string {
  return JSON.stringify({
    ts: "2026-06-14T00:00:00.000Z",
    tweet_id: "1",
    reply: "x",
    matched: [],
    ...rec,
  });
}

describe("parseFlaggedReplies", () => {
  it("returns [] for empty input", () => {
    expect(parseFlaggedReplies("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(parseFlaggedReplies("  \n\t\n  \n")).toEqual([]);
  });

  it("parses one valid record per line", () => {
    const text = [
      line({ tweet_id: "100", reply: "a", matched: ["hype"] }),
      line({ tweet_id: "101", reply: "b", matched: ["hedging"] }),
    ].join("\n");
    const out = parseFlaggedReplies(text);
    expect(out).toHaveLength(2);
    expect(out[0].tweet_id).toBe("100");
    expect(out[1].matched).toEqual(["hedging"]);
  });

  it("skips blank lines between valid records", () => {
    const text = [
      line({ tweet_id: "1", matched: ["hype"] }),
      "",
      "   ",
      line({ tweet_id: "2", matched: ["hedging"] }),
    ].join("\n");
    expect(parseFlaggedReplies(text)).toHaveLength(2);
  });

  it("skips a malformed (non-JSON) line without throwing and keeps valid neighbors", () => {
    const text = [
      line({ tweet_id: "1", matched: ["hype"] }),
      "{not valid json",
      line({ tweet_id: "2", matched: ["hedging"] }),
    ].join("\n");
    let out: FlaggedDigestRecord[] = [];
    expect(() => {
      out = parseFlaggedReplies(text);
    }).not.toThrow();
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.tweet_id)).toEqual(["1", "2"]);
  });

  it("skips a JSON line that is not a flagged-reply record (wrong shape)", () => {
    const text = [
      line({ tweet_id: "1", matched: ["hype"] }),
      JSON.stringify({ ts: 5, tweet_id: "2", reply: "b", matched: "nope" }),
      JSON.stringify([1, 2, 3]),
      JSON.stringify("a bare string"),
      line({ tweet_id: "3", matched: ["hedging"] }),
    ].join("\n");
    const out = parseFlaggedReplies(text);
    expect(out.map((r) => r.tweet_id)).toEqual(["1", "3"]);
  });

  it("drops non-string entries inside the matched array", () => {
    const text = JSON.stringify({
      ts: "t",
      tweet_id: "1",
      reply: "r",
      matched: ["hype", 7, null, "hedging"],
    });
    expect(parseFlaggedReplies(text)[0].matched).toEqual(["hype", "hedging"]);
  });
});

describe("aggregateByPattern", () => {
  it("returns [] for no records", () => {
    expect(aggregateByPattern([])).toEqual([]);
  });

  it("counts per pattern label across records", () => {
    const records: FlaggedDigestRecord[] = [
      { ts: "t", tweet_id: "1", reply: "a", matched: ["hype"] },
      { ts: "t", tweet_id: "2", reply: "b", matched: ["hype", "hedging"] },
      { ts: "t", tweet_id: "3", reply: "c", matched: ["hedging"] },
      { ts: "t", tweet_id: "4", reply: "d", matched: ["hedging"] },
    ];
    expect(aggregateByPattern(records)).toEqual([
      { label: "hedging", count: 3 },
      { label: "hype", count: 1 },
    ]);
  });

  it("sorts equal counts by label ascending for stable output", () => {
    const records: FlaggedDigestRecord[] = [
      { ts: "t", tweet_id: "1", reply: "a", matched: ["zeta"] },
      { ts: "t", tweet_id: "2", reply: "b", matched: ["alpha"] },
    ];
    expect(aggregateByPattern(records)).toEqual([
      { label: "alpha", count: 1 },
      { label: "zeta", count: 1 },
    ]);
  });

  it("ignores records with an empty matched array", () => {
    const records: FlaggedDigestRecord[] = [
      { ts: "t", tweet_id: "1", reply: "a", matched: [] },
      { ts: "t", tweet_id: "2", reply: "b", matched: ["hype"] },
    ];
    expect(aggregateByPattern(records)).toEqual([{ label: "hype", count: 1 }]);
  });
});

describe("renderDigest", () => {
  it("renders a clear 'nothing flagged' digest for empty input", () => {
    const md = renderDigest("");
    expect(md).toContain("## Humanizer feedback digest");
    expect(md.toLowerCase()).toContain("nothing flagged");
    // No count table when there is nothing to show.
    expect(md).not.toContain("| Pattern |");
  });

  it("renders a 'nothing flagged' digest when every line is malformed", () => {
    const md = renderDigest("garbage\n{bad\n\n   ");
    expect(md.toLowerCase()).toContain("nothing flagged");
  });

  it("renders a count table sorted desc with a total", () => {
    const text = [
      line({ tweet_id: "1", reply: "里程碑式发布", matched: ["hype"] }),
      line({ tweet_id: "2", reply: "某种程度上还行", matched: ["hedging"] }),
      line({ tweet_id: "3", reply: "颠覆性产品", matched: ["hype"] }),
    ].join("\n");
    const md = renderDigest(text);
    expect(md).toContain("## Humanizer feedback digest");
    expect(md).toContain("| Pattern | Count |");
    // hype (2) must appear before hedging (1) — desc order.
    const hypeIdx = md.indexOf("| hype |");
    const hedgingIdx = md.indexOf("| hedging |");
    expect(hypeIdx).toBeGreaterThan(-1);
    expect(hedgingIdx).toBeGreaterThan(-1);
    expect(hypeIdx).toBeLessThan(hedgingIdx);
    expect(md).toContain("| hype | 2 |");
    expect(md).toContain("3 flagged repl"); // total flagged replies
  });

  it("includes a few example replies and sanitizes them to a single line", () => {
    const text = [
      line({ tweet_id: "1", reply: "first line\nsecond line", matched: ["hype"] }),
      line({ tweet_id: "2", reply: "another example", matched: ["hedging"] }),
    ].join("\n");
    const md = renderDigest(text);
    expect(md.toLowerCase()).toContain("example");
    // The embedded newline in the reply must be collapsed so it cannot break
    // the markdown bullet/line structure.
    expect(md).toContain("first line second line");
    expect(md).not.toContain("first line\nsecond line");
  });

  it("caps the number of example replies", () => {
    const text = Array.from({ length: 20 }, (_, i) =>
      line({ tweet_id: String(i), reply: `reply ${i}`, matched: ["hype"] }),
    ).join("\n");
    const md = renderDigest(text);
    const exampleCount = (md.match(/reply \d+/g) ?? []).length;
    expect(exampleCount).toBeGreaterThan(0);
    expect(exampleCount).toBeLessThanOrEqual(5);
  });
});
