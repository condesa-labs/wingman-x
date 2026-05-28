import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKBLoader } from "../../src/kb-loader.js";
import {
  copyIntegrationFixture,
  createIsolatedStateDir,
  expectCacheDirUnderState,
  writeWingmanConfig,
} from "./support.js";

const OBSIDIAN_TONE =
  "# Sample Tone\n\nWrite with short, specific sentences. Prefer examples grounded in the vault.\n";

const OBSIDIAN_HANDLES = {
  tiers: [
    {
      tier: 1,
      label: "Core voices",
      policy: "every-run",
      handles: [
        { handle: "alice_ai" },
        { handle: "bob_builder", notes: "sharp launch writing" },
      ],
    },
    {
      tier: 2,
      label: "Research signals",
      policy: "sampled",
      handles: [
        { handle: "charlie_dev" },
        { handle: "dana_data", notes: "technical context" },
      ],
    },
    {
      tier: 3,
      label: "Manual review",
      policy: "manual",
      handles: [{ handle: "eve_ops", notes: "review before citing" }],
    },
  ],
};

describe("KB loader Obsidian integration", () => {
  it("loads the Obsidian adapter by package name and reads the sample vault through cache", async () => {
    const stateDir = createIsolatedStateDir("agent-kit-kb-loader-obsidian-");
    const vaultPath = join(stateDir, "vault");
    copyIntegrationFixture("obsidian-vault", vaultPath);
    writeWingmanConfig(stateDir, {
      version: 1,
      adapter: {
        package: "@winman-x/adapter-obsidian",
        name: "adapter-obsidian",
        config: { vaultPath },
      },
    });

    const loader = createKBLoader();
    expectCacheDirUnderState(loader, stateDir, "adapter-fs");
    await loader.refresh();

    expectCacheDirUnderState(loader, stateDir, "adapter-obsidian");
    expect(await loader.getTone()).toEqual({
      markdown: OBSIDIAN_TONE,
      meta: { source: join(vaultPath, "WingmanX", "VOICE.md") },
    });
    expect((await loader.listLibrary()).map((entry) => entry.id)).toEqual([
      "latency",
      "launch-notes",
    ]);
    expect(await loader.getHandles()).toEqual(OBSIDIAN_HANDLES);
    expect(loader.status().currentGeneration).toEqual(expect.any(String));
  });
});
