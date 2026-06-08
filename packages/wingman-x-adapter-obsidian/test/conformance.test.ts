import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runConformanceTests } from "@wingman-x/adapter-test-kit";
import { parseHandles } from "@wingman-x/kb-contract";
import { describe, expect, it } from "vitest";

import { configSchema, createAdapter, type ObsidianConfig } from "../src/index.js";

const vaultPath = resolve(import.meta.dirname, "fixtures/sample-vault");

describe("@wingman-x/adapter-obsidian conformance", () => {
  runConformanceTests<ObsidianConfig>({
    createAdapter,
    configSchema,
    fixtures: {
      config: configSchema.parse({ vaultPath }),
    },
    suiteName: "sample Obsidian vault fixture",
  });

  it("uses the shared handles parser for the populated handles fixture", async () => {
    const markdown = readFileSync(join(vaultPath, "WingmanX", "handles.md"), "utf8");
    const adapter = createAdapter(configSchema.parse({ vaultPath }));
    const parsed = parseHandles(markdown, "adapter-obsidian");

    expect(markdown.trim()).not.toBe("");
    expect(parsed.tiers.some((tier) => tier.handles.length > 0)).toBe(true);
    await expect(adapter.getHandles()).resolves.toEqual(parsed);
  });
});
