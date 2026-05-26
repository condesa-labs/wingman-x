import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAdapter } from "../src/adapter.js";
import { resolveRootPath } from "../src/config.js";

const previousStateDir = process.env.WINGMAN_X_STATE_DIR;

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.WINGMAN_X_STATE_DIR;
  } else {
    process.env.WINGMAN_X_STATE_DIR = previousStateDir;
  }
});

function writeMinimalKb(rootPath: string, tone: string): void {
  mkdirSync(join(rootPath, "library"), { recursive: true });
  writeFileSync(join(rootPath, "tone.md"), `# ${tone}\n`, "utf8");
  writeFileSync(join(rootPath, "library", "Entry.md"), "# Entry\nsearchable body\n", "utf8");
}

describe("filesystem adapter root resolution", () => {
  it("defaults to ~/.wingman-x/kb", () => {
    delete process.env.WINGMAN_X_STATE_DIR;

    expect(resolveRootPath({})).toBe(join(homedir(), ".wingman-x", "kb"));
  });

  it("uses rootPath config before the WINGMAN_X_STATE_DIR override", () => {
    process.env.WINGMAN_X_STATE_DIR = "/tmp/ignored-wingman-x-state";

    expect(resolveRootPath({ rootPath: "/tmp/explicit-kb" })).toBe("/tmp/explicit-kb");
  });

  it("maps WINGMAN_X_STATE_DIR to <state-dir>/kb and re-reads it per createAdapter call", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wingman-x-adapter-fs-"));
    try {
      const stateA = join(tempRoot, "state-a");
      const stateB = join(tempRoot, "state-b");
      writeMinimalKb(join(stateA, "kb"), "Tone A");
      writeMinimalKb(join(stateB, "kb"), "Tone B");

      process.env.WINGMAN_X_STATE_DIR = stateA;
      const adapterA = createAdapter({});

      process.env.WINGMAN_X_STATE_DIR = stateB;
      const adapterB = createAdapter({});

      await expect(adapterA.getTone()).resolves.toMatchObject({ markdown: "# Tone A\n" });
      await expect(adapterB.getTone()).resolves.toMatchObject({ markdown: "# Tone B\n" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
