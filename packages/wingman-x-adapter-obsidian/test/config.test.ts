import { describe, expect, it } from "vitest";

import { configSchema } from "../src/index.js";

const expectedFields = [
  "vaultPath",
  "wingmanRoot",
  "toneFile",
  "libraryFolder",
  "handlesFile",
  "followObsidianLinks",
] as const;

function shape(): Record<string, { description?: string }> {
  return (configSchema as unknown as { shape: Record<string, { description?: string }> }).shape;
}

describe("Obsidian config schema", () => {
  it("declares exactly the six CP05 fields with CLI prompt descriptions", () => {
    const fields = shape();

    expect(Object.keys(fields).sort()).toEqual([...expectedFields].sort());
    for (const field of expectedFields) {
      expect(fields[field]?.description).toEqual(expect.stringMatching(/\S/));
    }
  });

  it("applies defaults and rejects missing or extra fields", () => {
    expect(configSchema.parse({ vaultPath: "/vault" })).toEqual({
      vaultPath: "/vault",
      wingmanRoot: "WingmanX",
      toneFile: "VOICE.md",
      libraryFolder: "library",
      handlesFile: "handles.md",
      followObsidianLinks: false,
    });

    expect(configSchema.safeParse({}).success).toBe(false);
    expect(configSchema.safeParse({ vaultPath: "" }).success).toBe(false);
    expect(configSchema.safeParse({ vaultPath: "/vault", extra: "drift" }).success).toBe(false);
  });
});
