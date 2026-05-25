import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { configSchema, createAdapter } from "../src/index.js";

function writeMinimalVault(vaultPath: string, handlesMarkdown: string): void {
  const rootPath = join(vaultPath, "WingmanX");
  mkdirSync(join(rootPath, "library"), { recursive: true });
  writeFileSync(join(rootPath, "VOICE.md"), "# Tone\n", "utf8");
  writeFileSync(join(rootPath, "library", "Entry.md"), "# Entry\n", "utf8");
  writeFileSync(join(rootPath, "handles.md"), handlesMarkdown, "utf8");
}

describe("handles.md loading", () => {
  it("surfaces shared handles grammar errors as CONFIG_INVALID", async () => {
    const tempVault = mkdtempSync(join(tmpdir(), "wingman-x-obsidian-handles-"));
    try {
      writeMinimalVault(tempVault, "## Unknown Header\n- @alice_ai\n");
      const adapter = createAdapter(configSchema.parse({ vaultPath: tempVault }));

      await expect(adapter.getHandles()).rejects.toMatchObject({
        name: "KBAdapterError",
        code: "CONFIG_INVALID",
      });
      await expect(adapter.getHandles()).rejects.toThrow("handles.md line 1");
    } finally {
      rmSync(tempVault, { recursive: true, force: true });
    }
  });
});
