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
      config: { vaultPath },
    },
    suiteName: "sample Obsidian vault fixture",
  });

  it("uses the shared handles parser for the empty handles fixture", async () => {
    const markdown = readFileSync(join(vaultPath, "WingmanX", "handles.md"), "utf8");
    const adapter = createAdapter(configSchema.parse({ vaultPath }));

    expect(markdown).toBe("");
    await expect(adapter.getHandles()).resolves.toEqual(parseHandles(markdown, "adapter-obsidian"));
  });
});
