import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KBAdapterError } from "@wingman-x/kb-contract";
import {
  CACHE_SCHEMA_VERSION,
  createKBCache,
  type KBCachePayload,
} from "../src/kb-cache.js";
import {
  resolveKBCachePaths,
  resolveWingmanXStateDir,
} from "../src/kb-paths.js";

const require = createRequire(import.meta.url);

const properLockfile = require("proper-lockfile") as {
  lock: (
    path: string,
    options: {
      lockfilePath: string;
      realpath: false;
      stale: number;
      retries: number;
      onCompromised: (error: Error) => void;
    },
  ) => Promise<() => Promise<void>>;
};

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
  it("resolves WingmanX paths from env override or the home-dir default", () => {
    expect(resolveWingmanXStateDir({ WINGMAN_X_STATE_DIR: "/tmp/wingman-x" })).toBe(
      "/tmp/wingman-x",
    );
    expect(resolveWingmanXStateDir({ WINGMAN_X_STATE_DIR: "" })).toBe(
      join(homedir(), ".wingman-x"),
    );
    expect(resolveKBCachePaths("adapter-fs", "/tmp/state")).toMatchObject({
      currentPath: join("/tmp/state", "cache", "adapter-fs", "CURRENT"),
      lockPath: join("/tmp/state", "cache", ".adapter-fs.refresh.lock"),
    });
  });

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
    writeFileSync(currentFile(stateDir), `${JSON.stringify(current, null, 2)}\n`, "utf8");
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

  it("waits for an initializing cache lock when no current snapshot exists", async () => {
    const stateDir = tempStateDir();
    const cache = createKBCache({
      adapterName: "adapter-fs",
      stateDir,
      now: () => new Date("2026-05-25T03:30:00.000Z"),
      randomSuffix: () => "after-lock",
    });
    mkdirSync(cache.paths.cacheParent, { recursive: true });
    mkdirSync(cache.paths.adapterCacheDir, { recursive: true });
    mkdirSync(cache.paths.generationsDir, { recursive: true });
    const releaseHeldLock = await properLockfile.lock(cache.paths.lockPath, {
      lockfilePath: cache.paths.lockPath,
      realpath: false,
      stale: 60_000,
      retries: 0,
      onCompromised: () => undefined,
    });

    let loadCalls = 0;
    const refresh = cache.refresh(async () => {
      loadCalls += 1;
      return payload("after-lock");
    });

    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      expect(loadCalls).toBe(0);
      await releaseHeldLock();
      const snapshot = await refresh;
      expect(snapshot?.tone.markdown).toBe("# after-lock tone");
      expect(loadCalls).toBe(1);
    } catch (error) {
      await releaseHeldLock().catch(() => undefined);
      throw error;
    }
  });

  it("generates collision-safe ids, prunes old generations, and records health failures", async () => {
    const stateDir = tempStateDir();
    const emptyCache = createKBCache({
      adapterName: "adapter-fs",
      stateDir: tempStateDir(),
    });
    await emptyCache.writeHealthFailure(
      new KBAdapterError("UNKNOWN", "adapter-fs", "no current yet"),
    );

    let now = new Date("2026-05-25T04:00:00.000Z");
    const cache = createKBCache({
      adapterName: "adapter-fs",
      stateDir,
      now: () => now,
      randomSuffix: () => "same",
    });

    const first = await cache.refresh(async () => payload("first"));
    const second = await cache.refresh(async () => payload("second"));
    expect(first?.generation).not.toMatch(/[<>:"/\\|?*]/);
    expect(first?.generation).toContain("2026-05-25T04-00-00.000Z");
    expect(first?.writtenAt).toBe("2026-05-25T04:00:00.000Z");
    expect(second?.generation).not.toBe(first?.generation);
    expect(second?.generation.endsWith("-same-1")).toBe(true);

    now = new Date("2026-05-25T04:01:00.000Z");
    const third = await cache.refresh(async () => payload("third"));
    const generationsDir = join(stateDir, "cache", "adapter-fs", "generations");
    expect(readdirSync(generationsDir).sort()).toEqual(
      [second?.generation, third?.generation].sort(),
    );

    const healthPath = join(generationsDir, String(third?.generation), "health.json");
    rmSync(healthPath, { force: true });
    await cache.writeHealthFailure(
      new KBAdapterError("PERMISSION_DENIED", "adapter-fs", "cannot read source"),
    );
    const health = JSON.parse(readFileSync(healthPath, "utf8"));
    expect(health).toMatchObject({
      ok: false,
      stats: {
        libraryCount: 0,
        handlesCount: 0,
        toneBytes: 0,
      },
    });
    expect(health.errors.join("\n")).toContain("PERMISSION_DENIED");
  });
});
