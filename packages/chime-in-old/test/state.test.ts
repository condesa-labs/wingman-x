import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedPostSchema } from "../src/model/post.js";
import { openCandidateLog, parseCandidateLog } from "../src/state/candidate-log.js";
import { createMemoryProcessedStore, openProcessedStore, parseProcessedJsonl } from "../src/state/processed-store.js";
import { computeSince, loadScanState, saveScanState } from "../src/state/scan-state.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "chime-state-"));

describe("processed store", () => {
  it("appends durable JSONL lines and reloads with last-line-wins", () => {
    const path = join(tmp(), "processed.jsonl");
    const store = openProcessedStore(path);
    expect(store.size()).toBe(0);
    store.record({ tweet_id: "1", first_seen_at: "2026-09-04T00:00:00Z", processed_at: "2026-09-04T00:00:01Z", decision: "filtered", stage: "theme" });
    store.record({ tweet_id: "2", first_seen_at: "2026-09-04T00:00:00Z", processed_at: "2026-09-04T00:00:02Z", decision: "candidate" });
    store.record({ tweet_id: "1", first_seen_at: "2026-09-04T00:00:00Z", processed_at: "2026-09-04T00:00:03Z", decision: "candidate" });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);

    const reloaded = openProcessedStore(path);
    expect(reloaded.size()).toBe(2);
    expect(reloaded.has("1")).toBe(true);
    expect(reloaded.get("1")?.decision).toBe("candidate");
    expect(reloaded.has("3")).toBe(false);
  });

  it("ignores torn or malformed lines instead of failing", () => {
    const text = '{"tweet_id":"a","first_seen_at":"x","processed_at":"y","decision":"filtered"}\n{"tweet_id":"b",\nnot json\n{"tweet_id":"c","decision":"bogus"}\n';
    const map = parseProcessedJsonl(text);
    expect([...map.keys()]).toEqual(["a"]);
  });

  it("memory store never touches disk", () => {
    const store = createMemoryProcessedStore();
    store.record({ tweet_id: "9", first_seen_at: "x", processed_at: "y", decision: "filtered" });
    expect(store.has("9")).toBe(true);
    expect(store.path).toBe("<memory>");
  });
});

describe("scan state", () => {
  it("round-trips atomically and tolerates corruption", () => {
    const path = join(tmp(), "state.json");
    expect(loadScanState(path)).toEqual({ regen_handled: {} });
    saveScanState(path, { last_scan_started_at: "2026-09-04T10:00:00.000Z", regen_handled: { "1": "t" } });
    expect(loadScanState(path)).toEqual({ last_scan_started_at: "2026-09-04T10:00:00.000Z", regen_handled: { "1": "t" } });
    writeFileSync(path, "{not json");
    expect(loadScanState(path)).toEqual({ regen_handled: {} });
  });

  it("computeSince overlaps the previous scan by an hour but never exceeds the lookback", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(computeSince({ regen_handled: {} }, 36, now).toISOString()).toBe("2026-09-03T00:00:00.000Z");
    expect(computeSince({ last_scan_started_at: "2026-09-04T09:00:00.000Z", regen_handled: {} }, 36, now).toISOString()).toBe(
      "2026-09-04T08:00:00.000Z",
    );
    expect(computeSince({ last_scan_started_at: "2026-08-01T00:00:00.000Z", regen_handled: {} }, 36, now).toISOString()).toBe(
      "2026-09-03T00:00:00.000Z",
    );
  });
});

describe("candidate log", () => {
  it("upserts and reloads records; skips bad lines", () => {
    const path = join(tmp(), "candidates.jsonl");
    const log = openCandidateLog(path);
    const rec = {
      tweet_id: "1",
      recorded_at: "2026-09-04T00:00:00Z",
      post: NormalizedPostSchema.parse({
        tweet_id: "1",
        tweet_url: "https://x.com/a/status/1",
        author_handle: "a",
        tweet_text: "t",
        created_at: "2026-09-04T00:00:00Z",
        scraped_at: "2026-09-04T00:00:00Z",
      }),
      theme: "Custody",
      theme_score: 80,
      expertise_score: 80,
      contribution_score: 80,
      contribution_angle: "angle",
      account_priority: 1,
      kb_refs: ["library/custody.md"],
      chunk_refs: ["library/custody.md#what-i-know"],
      replies: ["first"],
    };
    log.upsert(rec);
    log.upsert({ ...rec, replies: ["first", "second"] });
    expect(openCandidateLog(path).get("1")?.replies).toEqual(["first", "second"]);
    expect(parseCandidateLog("garbage\n").size).toBe(0);
  });
});
