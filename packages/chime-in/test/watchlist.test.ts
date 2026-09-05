import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWatchlist, parseWatchlist } from "../src/watchlist.js";

describe("parseWatchlist", () => {
  it("parses a CSV with header, comments, quoted notes and priority words", () => {
    const text = [
      "# comment",
      "handle,priority,category,notes",
      "@alice,1,Institutional Crypto,\"knows custody, transfer agency\"",
      "bob,,Fintech,",
      "carol,peripheral,,",
      "ALICE,2,,duplicate should be ignored",
    ].join("\n");
    expect(parseWatchlist(text)).toEqual([
      { handle: "alice", priority: 1, category: "Institutional Crypto", notes: "knows custody, transfer agency" },
      { handle: "bob", priority: 2, category: "Fintech" },
      { handle: "carol", priority: 3 },
    ]);
  });

  it("accepts plain handle-per-line files", () => {
    expect(parseWatchlist("@one\ntwo\n\n# three\n")).toEqual([
      { handle: "one", priority: 2 },
      { handle: "two", priority: 2 },
    ]);
  });

  it("rejects invalid handles and priorities with line numbers", () => {
    expect(() => parseWatchlist("handle\nthis handle is way too long")).toThrow(/line 2/);
    expect(() => parseWatchlist("handle,priority\nok,9")).toThrow(/priority/);
  });

  it("returns [] for an empty file", () => {
    expect(parseWatchlist("# nothing\n")).toEqual([]);
  });
});

describe("loadWatchlist", () => {
  it("gives an actionable error when the file is missing or empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chime-wl-"));
    await expect(loadWatchlist(join(dir, "missing.csv"))).rejects.toThrow(/watchlist not found/);
    const empty = join(dir, "empty.csv");
    writeFileSync(empty, "# none\n");
    await expect(loadWatchlist(empty)).rejects.toThrow(/empty/);
    const ok = join(dir, "ok.csv");
    writeFileSync(ok, "handle\nalice\n");
    expect(await loadWatchlist(ok)).toEqual([{ handle: "alice", priority: 2 }]);
  });
});
