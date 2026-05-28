import type { AdapterModule, KBAdapter } from "@winman-x/kb-contract";
import { describe, expect, it } from "vitest";

import * as adapterObsidian from "../src/index.js";
import type { ObsidianConfig } from "../src/index.js";

describe("public entrypoint exports", () => {
  it("exports named createAdapter and configSchema without a default export", () => {
    expect(Object.keys(adapterObsidian).sort()).toEqual(["configSchema", "createAdapter"]);
    expect("default" in adapterObsidian).toBe(false);
  });

  it("satisfies AdapterModule<ObsidianConfig> at compile time", () => {
    const module: AdapterModule<ObsidianConfig> = adapterObsidian;
    const parsed = module.configSchema.parse({ vaultPath: "/tmp/wingman-x-vault" });
    expect(parsed).toEqual({
      vaultPath: "/tmp/wingman-x-vault",
      wingmanRoot: "WingmanX",
      toneFile: "VOICE.md",
      libraryFolder: "library",
      handlesFile: "handles.md",
      followObsidianLinks: false,
    });

    const adapter: KBAdapter = module.createAdapter(parsed);
    expect(adapter).toMatchObject({
      schemaVersion: "1",
      name: "adapter-obsidian",
      displayName: "Obsidian",
    });
  });
});
