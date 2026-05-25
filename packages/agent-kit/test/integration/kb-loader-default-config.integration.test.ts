import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKBLoader } from "../../src/kb-loader.js";
import {
  copyIntegrationFixture,
  createIsolatedStateDir,
  expectCacheDirUnderState,
} from "./support.js";

const DEFAULT_TONE =
  "# Default Loader Tone\n\nUse the state-dir default KB when no config exists.\n";

const DEFAULT_HANDLES = {
  tiers: [
    {
      tier: 1,
      label: "Default reviewers",
      policy: "every-run",
      handles: [{ handle: "default_alice" }],
    },
  ],
};

describe("KB loader default config integration", () => {
  it("uses the missing-config fs default under WINGMAN_X_STATE_DIR and logs the fallback", async () => {
    const stateDir = createIsolatedStateDir("agent-kit-kb-loader-default-");
    copyIntegrationFixture("default-kb", join(stateDir, "kb"));
    const logs: Array<Record<string, unknown>> = [];

    const loader = createKBLoader({
      log: (event) => logs.push(event),
    });
    expectCacheDirUnderState(loader, stateDir, "adapter-fs");
    await loader.refresh();

    expectCacheDirUnderState(loader, stateDir, "adapter-fs");
    expect(await loader.getTone()).toEqual({
      markdown: DEFAULT_TONE,
      meta: { source: join(stateDir, "kb", "tone.md") },
    });
    expect((await loader.listLibrary()).map((entry) => entry.id)).toEqual([
      "defaults",
    ]);
    expect(await loader.getHandles()).toEqual(DEFAULT_HANDLES);
    expect(logs).toContainEqual({
      event: "kb_config_default_used",
      reason: "missing",
    });
    expect(loader.status().currentGeneration).toEqual(expect.any(String));
  });
});
