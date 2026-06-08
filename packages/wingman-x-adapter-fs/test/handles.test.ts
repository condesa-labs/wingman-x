import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KBAdapterError, parseHandles } from "@wingman-x/kb-contract";
import { describe, expect, it } from "vitest";

import { createAdapter } from "../src/index.js";

const sampleRoot = resolve(import.meta.dirname, "fixtures/sample-kb");

function writeMinimalKb(rootPath: string, handlesMarkdown: string): void {
  mkdirSync(join(rootPath, "library"), { recursive: true });
  writeFileSync(join(rootPath, "tone.md"), "# Tone\n", "utf8");
  writeFileSync(join(rootPath, "library", "Entry.md"), "# Entry\n", "utf8");
  writeFileSync(join(rootPath, "handles.md"), handlesMarkdown, "utf8");
}

describe("handles.md loading", () => {
  it("uses the shared parseHandles grammar for handles.md", async () => {
    const markdown = readFileSync(join(sampleRoot, "handles.md"), "utf8");
    const adapter = createAdapter({ rootPath: sampleRoot });

    await expect(adapter.getHandles()).resolves.toEqual(parseHandles(markdown, "adapter-fs"));
  });

  it("surfaces shared handles grammar errors as CONFIG_INVALID", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wingman-x-handles-"));
    try {
      writeMinimalKb(tempRoot, "## Unknown Header\n- @alice_ai\n");
      const adapter = createAdapter({ rootPath: tempRoot });

      await expect(adapter.getHandles()).rejects.toMatchObject({
        name: "KBAdapterError",
        code: "CONFIG_INVALID",
      } satisfies Partial<KBAdapterError>);
      await expect(adapter.getHandles()).rejects.toThrow("handles.md line 1");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
