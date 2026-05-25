import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_SCHEMA_VERSION,
  createKBCache,
  type KBCachePayload,
} from "../src/kb-cache.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-kb-cache-"));
  tempDirs.push(dir);
  return dir;
}

function payload(label: string, adapterVersion = "1.0.0"): KBCachePayload {
  return {
    adapterVersion,
    tone: {
      markdown: `# ${label} tone`,
      meta: { version: adapterVersion },
    },
    library: [
      {
        id: `${label}-entry`,
        title: `${label} entry`,
      },
    ],
    libraryContents: {
      [`${label}-entry`]: {
        id: `${label}-entry`,
        title: `${label} entry`,
        markdown: `# ${label} entry`,
      },
    },
    handles: { tiers: [] },
    health: {
      ok: true,
      stats: {
        libraryCount: 1,
        handlesCount: 0,
        toneBytes: Buffer.byteLength(`# ${label} tone`, "utf8"),
      },
      warnings: [],
      errors: [],
    },
  };
}

function currentFile(stateDir: string): string {
  return join(stateDir, "cache", "adapter-fs", "CURRENT");
}

describe("KB generation cache", () => {
  it("keeps the old generation visible if refresh aborts before CURRENT rename", async () => {
    const stateDir = tempStateDir();
    let suffix = "old";
    let now = new Date("2026-05-25T01:00:00.000Z");
    const cache = createKBCache({
      adapterName: "adapter-fs",
      stateDir,
      now: () => now,
      randomSuffix: () => suffix,
    });

    await cache.refresh(async () => payload("old"));
    const oldSnapshot = await cache.read();
    expect(oldSnapshot?.tone.markdown).toBe("# old tone");
    expect(oldSnapshot?.library.map((entry) => entry.id)).toEqual(["old-entry"]);

    suffix = "new";
    now = new Date("2026-05-25T01:01:00.000Z");
    const crashingCache = createKBCache({
      adapterName: "adapter-fs",
      stateDir,
      now: () => now,
      randomSuffix: () => suffix,
      hooks: {
        afterGenerationFilesWritten: async () => {
          throw new Error("simulated crash before CURRENT");
        },
      },
    });

    await expect(crashingCache.refresh(async () => payload("new"))).rejects.toThrow(
      /simulated crash/,
    );

    const visibleSnapshot = await cache.read();
    expect(visibleSnapshot?.generation).toBe(oldSnapshot?.generation);
    expect(visibleSnapshot?.tone.markdown).toBe("# old tone");
    expect(visibleSnapshot?.library.map((entry) => entry.id)).toEqual(["old-entry"]);
  });

  it("places the refresh lock beside the adapter cache and returns stale cache when held", async () => {
    const stateDir = tempStateDir();
    const cache = createKBCache({
      adapterName: "adapter-fs",
      stateDir,
      now: () => new Date("2026-05-25T02:00:00.000Z"),
      randomSuffix: () => "seed",
    });
    await cache.refresh(async () => payload("seed"));

    expect(cache.paths.lockPath).toBe(join(stateDir, "cache", ".adapter-fs.refresh.lock"));
    expect(cache.paths.adapterCacheDir).toBe(join(stateDir, "cache", "adapter-fs"));
    mkdirSync(cache.paths.lockPath, { recursive: true });

    const startedAt = Date.now();
    const snapshot = await cache.refresh(async () => payload("blocked"));
    expect(Date.now() - startedAt).toBeLessThan(750);
    expect(snapshot?.tone.markdown).toBe("# seed tone");
    expect(existsSync(cache.paths.lockPath)).toBe(true);
  });

  it("rebuilds older cache schema generations and tolerates a stale lock directory", async () => {
    const stateDir = tempStateDir();
    let suffix = "old-schema";
    const cache = createKBCache({
      adapterName: "adapter-fs",
      stateDir,
      now: () => new Date("2026-05-25T03:00:00.000Z"),
      randomSuffix: () => suffix,
    });
    await cache.refresh(async () => payload("old"));
    const oldGeneration = (await cache.read())?.generation;
    expect(oldGeneration).toBeTruthy();

    const current = JSON.parse(readFileSync(currentFile(stateDir), "utf8"));
    current.cacheSchemaVersion = CACHE_SCHEMA_VERSION - 1;
    mkdirSync(cache.paths.lockPath, { recursive: true });
    const staleTime = new Date(Date.now() - 61_000);
    utimesSync(cache.paths.lockPath, staleTime, staleTime);

    suffix = "rebuilt";
    const rebuilt = await cache.refresh(async () => payload("rebuilt", "1.1.0"));
    expect(rebuilt?.tone.markdown).toBe("# rebuilt tone");
    expect(rebuilt?.generation).not.toBe(oldGeneration);

    const generations = readdirSync(join(stateDir, "cache", "adapter-fs", "generations"));
    expect(generations).toEqual([rebuilt?.generation]);
    const rewrittenCurrent = JSON.parse(readFileSync(currentFile(stateDir), "utf8"));
    expect(rewrittenCurrent.cacheSchemaVersion).toBe(CACHE_SCHEMA_VERSION);
  });
});
