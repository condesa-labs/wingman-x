import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createAdapter } from "../src/index.js";

const sampleRoot = resolve(import.meta.dirname, "fixtures/sample-kb");

function writeKbFiles(rootPath: string, files: Record<string, string>): void {
  mkdirSync(join(rootPath, "library"), { recursive: true });
  writeFileSync(join(rootPath, "tone.md"), "# Tone\n", "utf8");
  for (const [fileName, markdown] of Object.entries(files)) {
    writeFileSync(join(rootPath, "library", fileName), markdown, "utf8");
  }
}

describe("library loading", () => {
  it("derives ids from lowercased markdown basenames with shared slug rules", async () => {
    const adapter = createAdapter({ rootPath: sampleRoot });

    await expect(adapter.listLibrary()).resolves.toEqual([
      { id: "latency", title: "Latency Notes" },
      { id: "launch-notes", title: "Launch Notes" },
    ]);
  });

  it("returns full markdown content for a library entry and NOT_FOUND for unknown ids", async () => {
    const adapter = createAdapter({ rootPath: sampleRoot });

    await expect(adapter.getLibraryEntry("latency")).resolves.toMatchObject({
      id: "latency",
      title: "Latency Notes",
      markdown: expect.stringContaining("measurement windows"),
    });
    await expect(adapter.getLibraryEntry("missing")).rejects.toMatchObject({
      name: "KBAdapterError",
      code: "NOT_FOUND",
    });
  });

  it("implements dependency-free searchLibrary over loaded entries and content", async () => {
    const adapter = createAdapter({ rootPath: sampleRoot });

    await expect(adapter.searchLibrary?.("measurement", 5)).resolves.toEqual([
      { id: "latency", title: "Latency Notes" },
    ]);
    await expect(adapter.searchLibrary?.("launch", 5)).resolves.toEqual([
      { id: "launch-notes", title: "Launch Notes" },
    ]);
    await expect(adapter.searchLibrary?.("not-present", 5)).resolves.toEqual([]);
  });

  it("rejects source files that derive colliding ids with CONFIG_INVALID naming both paths", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wingman-x-collision-"));
    try {
      const firstPath = join(tempRoot, "library", "Foo Bar.md");
      const secondPath = join(tempRoot, "library", "foo-bar.md");
      writeKbFiles(tempRoot, {
        "Foo Bar.md": "# First\n",
        "foo-bar.md": "# Second\n",
      });
      const adapter = createAdapter({ rootPath: tempRoot });

      await expect(adapter.listLibrary()).rejects.toMatchObject({
        name: "KBAdapterError",
        code: "CONFIG_INVALID",
      });
      await expect(adapter.listLibrary()).rejects.toThrow(firstPath);
      await expect(adapter.listLibrary()).rejects.toThrow(secondPath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects source files that derive an empty id with CONFIG_INVALID naming the path", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wingman-x-empty-id-"));
    try {
      const sourcePath = join(tempRoot, "library", "___.md");
      writeKbFiles(tempRoot, {
        "___.md": "# Empty Id\n",
      });
      const adapter = createAdapter({ rootPath: tempRoot });

      await expect(adapter.listLibrary()).rejects.toMatchObject({
        name: "KBAdapterError",
        code: "CONFIG_INVALID",
      });
      await expect(adapter.listLibrary()).rejects.toThrow(sourcePath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
