import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AI_TELL_PATTERNS,
  detectAiTells,
  appendFlaggedReply,
} from "../src/watcher-core.js";

/**
 * Detector tests (CP02). Two surfaces under test:
 *   - `detectAiTells` — pure label matcher over the Tier-1 regex set.
 *   - `appendFlaggedReply` — local JSONL appender keyed off the
 *     WINGMAN_X_STATE_DIR helper, with an injected `ts`.
 *
 * Business invariant: the detector flags high-precision AI phrasings only.
 * It must NOT fire on the deliberately-excluded common single words
 * (作为/体现/反映/是), nor on natural prose that merely contains a substring
 * of an included pattern. It must never throw on adversarial input.
 */

const tmpDirs: string[] = [];
function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wingman-x-flagtest-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("AI_TELL_PATTERNS", () => {
  it("is a non-empty array of labeled regexes", () => {
    expect(Array.isArray(AI_TELL_PATTERNS)).toBe(true);
    expect(AI_TELL_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of AI_TELL_PATTERNS) {
      expect(typeof entry.label).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.re).toBeInstanceOf(RegExp);
    }
  });

  it("does NOT include the deliberately-excluded common single words in any regex source", () => {
    // 作为/体现/反映/是 are Tier-2 (prompt-only). They must never appear as
    // literal regex sources here, or precision collapses.
    const sources = AI_TELL_PATTERNS.map((p) => p.re.source).join("\n");
    expect(sources).not.toContain("作为");
    expect(sources).not.toContain("体现");
    expect(sources).not.toContain("反映");
  });
});

describe("detectAiTells — positive matches (every Tier-1 pattern fires)", () => {
  it.each([
    // Chinese contrastive
    ["不是X而是Y的对比句", "这不是工具而是平台"],
    ["并非…而是", "这并非偶然而是必然"],
    ["不在…而在", "重点不在速度而在方向"],
    ["而非", "这是能力而非运气"],
    // English contrastive
    ["not X but Y", "It is not magic but engineering."],
    ["it's not …, it's", "It's not about speed, it's about depth."],
    // Hype
    ["里程碑/重磅 hype", "这是一个划时代的里程碑"],
    // Hedging
    ["在一定程度上 hedging", "在一定程度上这是对的"],
    ["某种意义上 hedging", "某种意义上你说得对"],
    // English AI vocab
    ["delve into / transformative", "Let me delve into this transformative idea."],
    ["game-changer", "This is a real game-changer."],
    ["unlock … potential", "It will unlock your full potential."],
    // Canned openings
    ["canned opening: great point", "Great point, I totally agree."],
    ["canned opening: fascinating", "Fascinating thread on agents."],
  ])("flags %s", (_name, reply) => {
    const matched = detectAiTells(reply);
    expect(matched.length).toBeGreaterThan(0);
  });
});

describe("detectAiTells — false-positive guards (excluded common words)", () => {
  it.each([
    "作为开发者我觉得不错",
    "这点体现得挺好",
    "能反映真实情况",
  ])("returns [] for excluded-word phrase %s", (reply) => {
    expect(detectAiTells(reply)).toEqual([]);
  });
});

describe("detectAiTells — natural-prose negatives per included regex", () => {
  // Each included contrastive/hedging regex needs a genuine sentence that
  // exercises the same characters WITHOUT the AI-tell structure, proving the
  // regex is precise (not a bare substring match).
  it("does not match natural prose containing 而 without 而非/而是", () => {
    expect(detectAiTells("我喝了茶，而你喝了咖啡")).toEqual([]);
  });

  it("does not match a plain 'not ... but' absence (no comma+conjunction tell)", () => {
    // 'not' and 'but' appear but not in the `not WORD but` adjacency.
    expect(detectAiTells("I do not know. But I will try.")).toEqual([]);
  });

  it("does not match 'not enough but' style where the contrastive structure is absent", () => {
    // Sentence uses 'but' far from 'not' so /\bnot\s+\w+,?\s+but\b/ cannot match.
    expect(
      detectAiTells("She is not the kind of person who gives up but that is fine."),
    ).toEqual([]);
  });

  it("does not match 程度 used in a non-hedging way", () => {
    expect(detectAiTells("这个程度的难度我能接受")).toEqual([]);
  });

  it("does not match 'unlock' without the potential collocation", () => {
    expect(detectAiTells("I need to unlock the door first.")).toEqual([]);
  });
});

describe("detectAiTells — dedup and stable order", () => {
  it("dedupes repeated matches of the same label", () => {
    const matched = detectAiTells("而非这个，而非那个，而非其他");
    const unique = new Set(matched);
    expect(matched.length).toBe(unique.size);
  });

  it("returns labels in a stable order across calls", () => {
    const reply = "It's not about speed, it's about depth — a real game-changer.";
    const a = detectAiTells(reply);
    const b = detectAiTells(reply);
    expect(a).toEqual(b);
  });
});

describe("detectAiTells — fault-path inputs never throw", () => {
  it("returns [] for empty string", () => {
    expect(detectAiTells("")).toEqual([]);
  });

  it("returns [] for non-ASCII / emoji-only input", () => {
    expect(detectAiTells("🚀🔥😀 αβγ こんにちは")).toEqual([]);
  });

  it("does not throw or hang on very long input", () => {
    const long = "a ".repeat(50_000) + "harmless tail";
    expect(() => detectAiTells(long)).not.toThrow();
    expect(detectAiTells(long)).toEqual([]);
  });
});

describe("appendFlaggedReply — local JSONL log", () => {
  it("writes exactly one line for a flagged reply using the injected ts and temp state dir", () => {
    const stateDir = makeStateDir();
    appendFlaggedReply({
      stateDir,
      ts: "2026-06-14T00:00:00.000Z",
      tweet_id: "tweet-1",
      reply: "这并非偶然而是必然",
      matched: ["contrastive-zh"],
    });

    const logPath = join(stateDir, "flagged-replies.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toEqual({
      ts: "2026-06-14T00:00:00.000Z",
      tweet_id: "tweet-1",
      reply: "这并非偶然而是必然",
      matched: ["contrastive-zh"],
    });
  });

  it("appends a second line rather than overwriting", () => {
    const stateDir = makeStateDir();
    appendFlaggedReply({
      stateDir,
      ts: "2026-06-14T00:00:00.000Z",
      tweet_id: "tweet-1",
      reply: "r1",
      matched: ["a"],
    });
    appendFlaggedReply({
      stateDir,
      ts: "2026-06-14T00:00:01.000Z",
      tweet_id: "tweet-2",
      reply: "r2",
      matched: ["b"],
    });
    const logPath = join(stateDir, "flagged-replies.jsonl");
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).tweet_id).toBe("tweet-2");
  });

  it("creates the state dir if it does not exist (mkdir -p)", () => {
    const parent = makeStateDir();
    const stateDir = join(parent, "nested", "deep");
    expect(existsSync(stateDir)).toBe(false);
    appendFlaggedReply({
      stateDir,
      ts: "2026-06-14T00:00:00.000Z",
      tweet_id: "tweet-x",
      reply: "r",
      matched: ["a"],
    });
    expect(existsSync(join(stateDir, "flagged-replies.jsonl"))).toBe(true);
  });
});
