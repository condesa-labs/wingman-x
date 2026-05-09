import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildLibraryMarkdown,
  classifyNote,
  collectMarkdownNotes,
  type Topic,
} from "../src/kb-seed-core.js";

const fixtureVault = resolve(
  "test/fixtures/obsidian-vault",
);

async function readFixture(relativePath: string): Promise<string> {
  return readFile(join(fixtureVault, relativePath), "utf8");
}

describe("kb seed classification", () => {
  it("classifies AI, investing, productivity, and irrelevant notes", async () => {
    const cases: Array<[string, Topic[]]> = [
      ["ai/agent-systems.md", ["ai"]],
      ["ai/model-evals.md", ["ai"]],
      ["investing/portfolio-discipline.md", ["investing"]],
      ["investing/china-market-notes.md", ["investing"]],
      ["productivity/automation-workflows.md", ["productivity"]],
      ["productivity/focus-systems.md", ["productivity"]],
      ["personal/noise.md", []],
    ];

    for (const [relativePath, expected] of cases) {
      const content = await readFixture(relativePath);
      expect(classifyNote({ relativePath, content })).toEqual(expected);
    }
  });

  it("collects markdown notes safely and produces deterministic topic ordering", async () => {
    const notes = await collectMarkdownNotes(fixtureVault);
    expect(notes.map((n) => n.relativePath)).toEqual([
      "ai/agent-systems.md",
      "ai/model-evals.md",
      "investing/china-market-notes.md",
      "investing/portfolio-discipline.md",
      "personal/noise.md",
      "productivity/automation-workflows.md",
      "productivity/focus-systems.md",
    ]);

    const first = buildLibraryMarkdown(notes);
    const second = buildLibraryMarkdown([...notes].reverse());
    expect(second).toEqual(first);
    expect(Object.keys(first)).toEqual(["ai", "investing", "productivity"]);
    expect(first.ai.startsWith("# AI\n\n")).toBe(true);
    expect(first.investing.startsWith("# Investing\n\n")).toBe(true);
    expect(first.productivity.startsWith("# Productivity\n\n")).toBe(true);
    expect(first.ai).toContain("agent-systems.md");
    expect(first.investing).toContain("china-market-notes.md");
    expect(first.productivity).toContain("automation-workflows.md");
    expect(first.ai).not.toContain("noise.md");
  });

  it("covers walker safety branches for symlinks, large files, file cap, and empty output", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kb-seed-safe-"));
    const notADir = join(vault, "not-a-dir.txt");
    const logs: string[] = [];
    try {
      writeFileSync(
        join(vault, "a.md"),
        "# AI Note\n\nAI agent evaluation prompt retrieval model.",
      );
      writeFileSync(
        join(vault, ".hidden.md"),
        "# Hidden\n\nAI agent model prompt workflow",
      );
      writeFileSync(join(vault, "big.md"), "# Big\n\n" + "x".repeat(128));
      writeFileSync(notADir, "plain file");
      mkdirSync(join(vault, "nested"));
      writeFileSync(
        join(vault, "nested", "b.md"),
        "# Productivity Note\n\nworkflow automation checklist task focus efficiency",
      );
      symlinkSync(join(vault, "a.md"), join(vault, "linked.md"));

      const notes = await collectMarkdownNotes(vault, {
        maxFileBytes: 80,
        log: (line) => logs.push(line),
      });
      expect(notes.map((n) => n.relativePath)).toEqual([
        "a.md",
        "nested/b.md",
      ]);
      expect(logs.some((line) => line.includes('"reason":"file_too_large"'))).toBe(true);
      expect(logs.some((line) => line.includes('"reason":"symlink"'))).toBe(true);

      const cappedLogs: string[] = [];
      const capped = await collectMarkdownNotes(vault, {
        maxFiles: 2,
        maxFileBytes: 128,
        log: (line) => cappedLogs.push(line),
      });
      expect(capped.map((n) => n.relativePath)).toEqual(["a.md"]);
      expect(
        cappedLogs.some((line) => line.includes('"event":"kb_seed_file_cap_reached"')),
      ).toBe(true);

      await expect(collectMarkdownNotes(notADir)).rejects.toThrow(
        /vault is not a real directory/,
      );

      const empty = buildLibraryMarkdown([]);
      expect(empty.ai).toContain("No matching source notes");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe("seed-kb-from-obsidian script", () => {
  it("writes byte-identical output when run twice against the fixture vault", async () => {
    const outA = mkdtempSync(join(tmpdir(), "kb-seed-a-"));
    const outB = mkdtempSync(join(tmpdir(), "kb-seed-b-"));
    try {
      for (const out of [outA, outB]) {
        const run = spawnSync(
          "npx",
          [
            "tsx",
            "scripts/seed-kb-from-obsidian.ts",
            "--vault",
            fixtureVault,
            "--out",
            out,
          ],
          {
            cwd: resolve("."),
            encoding: "utf8",
          },
        );
        expect(run.status, run.stderr || run.stdout).toBe(0);
      }

      const files = (await readdir(outA)).sort();
      expect(files).toEqual(["ai.md", "investing.md", "productivity.md"]);
      for (const file of files) {
        expect(readFileSync(join(outB, file), "utf8")).toBe(
          readFileSync(join(outA, file), "utf8"),
        );
      }
    } finally {
      rmSync(outA, { recursive: true, force: true });
      rmSync(outB, { recursive: true, force: true });
    }
  });
});
