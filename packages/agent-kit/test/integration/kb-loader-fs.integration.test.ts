import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKBLoader } from "../../src/kb-loader.js";
import {
  copyIntegrationFixture,
  createIsolatedStateDir,
  expectCacheDirUnderState,
  writeWingmanConfig,
} from "./support.js";

const FS_TONE =
  "# Loader FS Tone\n\nUse measured examples and keep replies crisp.\n";
const UPDATED_FS_TONE =
  "# Loader FS Tone\n\nUpdated tone from the mutated fixture.\n";

const FS_HANDLES = {
  tiers: [
    {
      tier: 1,
      label: "Core peers",
      policy: "every-run",
      handles: [
        { handle: "fs_alice" },
        { handle: "fs_bob", notes: "latency reviewer" },
      ],
    },
    {
      tier: 2,
      label: "Field notes",
      policy: "sampled",
      handles: [{ handle: "fs_casey" }],
    },
  ],
};

describe("KB loader fs integration", () => {
  it("loads fs adapter by package name, writes cache files, and rotates generations", async () => {
    const stateDir = createIsolatedStateDir("agent-kit-kb-loader-fs-");
    const rootPath = join(stateDir, "fixture-kb");
    copyIntegrationFixture("fs-kb", rootPath);
    writeWingmanConfig(stateDir, {
      version: 1,
      adapter: {
        package: "@winman-x/adapter-fs",
        name: "adapter-fs",
        config: { rootPath },
      },
    });

    let now = new Date("2026-05-25T08:00:00.000Z");
    let suffix = "first";
    const loader = createKBLoader({
      now: () => now,
      randomSuffix: () => suffix,
    });

    expectCacheDirUnderState(loader, stateDir, "adapter-fs");
    await loader.refresh();
    const cacheDir = expectCacheDirUnderState(loader, stateDir, "adapter-fs");
    expect(await loader.getTone()).toEqual({
      markdown: FS_TONE,
      meta: { source: join(rootPath, "tone.md") },
    });
    expect((await loader.listLibrary()).map((entry) => entry.id)).toEqual([
      "latency",
      "launch-notes",
    ]);
    expect(await loader.getHandles()).toEqual(FS_HANDLES);
    expect(existsSync(join(cacheDir, "CURRENT"))).toBe(true);

    const firstGeneration = loader.status().currentGeneration;
    expect(firstGeneration).toEqual(expect.any(String));

    writeFileSync(join(rootPath, "tone.md"), UPDATED_FS_TONE, "utf8");
    now = new Date("2026-05-25T08:01:00.000Z");
    suffix = "second";
    await loader.refresh();

    const secondGeneration = loader.status().currentGeneration;
    expect(secondGeneration).toEqual(expect.any(String));
    expect(secondGeneration).not.toBe(firstGeneration);
    expect(await loader.getTone()).toEqual({
      markdown: UPDATED_FS_TONE,
      meta: { source: join(rootPath, "tone.md") },
    });
    expect(
      readFileSync(
        join(cacheDir, "generations", String(secondGeneration), "tone.json"),
        "utf8",
      ),
    ).toContain("Updated tone from the mutated fixture.");
  });
});
