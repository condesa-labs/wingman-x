import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KBAdapterError,
  type AdapterModule,
  type HandleSet,
  type HealthReport,
  type KBAdapter,
  type LibraryContent,
  type LibraryEntry,
  type ToneResult,
} from "@wingman-x/kb-contract";
import { createKBLoader } from "../src/kb-loader.js";

const originalStateDir = process.env.WINGMAN_X_STATE_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.WINGMAN_X_STATE_DIR;
  } else {
    process.env.WINGMAN_X_STATE_DIR = originalStateDir;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-kb-loader-"));
  tempDirs.push(dir);
  process.env.WINGMAN_X_STATE_DIR = dir;
  return dir;
}

function writeConfig(stateDir: string, value: unknown): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify(value, null, 2), "utf8");
}

function seedDefaultFsKB(stateDir: string): void {
  mkdirSync(join(stateDir, "kb", "library"), { recursive: true });
  writeFileSync(join(stateDir, "kb", "tone.md"), "# Default tone\n", "utf8");
  writeFileSync(join(stateDir, "kb", "library", "agents.md"), "# Agents\n\nAgent notes.\n", "utf8");
}

async function waitForAssertion(assertion: () => Promise<void> | void): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }

  throw lastError;
}

interface MutableAdapterState {
  tone: ToneResult;
  library: LibraryEntry[];
  contents: Record<string, LibraryContent | KBAdapterError>;
  handles: HandleSet;
  fail?: KBAdapterError;
}

function makeAdapter(state: MutableAdapterState): KBAdapter & {
  getTone: ReturnType<typeof vi.fn>;
  listLibrary: ReturnType<typeof vi.fn>;
  getLibraryEntry: ReturnType<typeof vi.fn>;
  getHandles: ReturnType<typeof vi.fn>;
} {
  const health = (): HealthReport => ({
    ok: true,
    stats: {
      libraryCount: state.library.length,
      handlesCount: state.handles.tiers.reduce((total, tier) => total + tier.handles.length, 0),
      toneBytes: Buffer.byteLength(state.tone.markdown, "utf8"),
    },
    warnings: [],
    errors: [],
  });

  return {
    schemaVersion: "1",
    name: "test-adapter",
    version: "1.0.0",
    displayName: "Test Adapter",
    healthCheck: vi.fn(async () => health()),
    getTone: vi.fn(async () => {
      if (state.fail !== undefined) {
        throw state.fail;
      }
      return state.tone;
    }),
    listLibrary: vi.fn(async () => {
      if (state.fail !== undefined) {
        throw state.fail;
      }
      return state.library;
    }),
    getLibraryEntry: vi.fn(async (id: string) => {
      if (state.fail !== undefined) {
        throw state.fail;
      }
      const content = state.contents[id];
      if (content instanceof KBAdapterError) {
        throw content;
      }
      if (content === undefined) {
        throw new KBAdapterError("NOT_FOUND", "test-adapter", `missing ${id}`);
      }
      return content;
    }),
    getHandles: vi.fn(async () => {
      if (state.fail !== undefined) {
        throw state.fail;
      }
      return state.handles;
    }),
  };
}

function adapterModule(adapter: KBAdapter): AdapterModule<Record<string, unknown>> {
  return {
    configSchema: z.record(z.string(), z.unknown()),
    createAdapter: () => adapter,
  };
}

function testConfig(adapterPackage = "test-adapter"): unknown {
  return {
    version: 1,
    adapter: {
      package: adapterPackage,
      name: "test-adapter",
      config: {},
    },
  };
}

describe("KB loader configuration", () => {
  it("reports the default cache dir before refresh and lazily refreshes on first getter", async () => {
    const stateDir = tempStateDir();
    writeConfig(stateDir, testConfig());
    const adapter = makeAdapter({
      tone: { markdown: "lazy-tone", meta: {} },
      library: [],
      contents: {},
      handles: { tiers: [] },
    });
    const loader = createKBLoader({
      importModule: async () => adapterModule(adapter),
    });

    expect(loader.status()).toMatchObject({
      cacheDir: join(stateDir, "cache", "adapter-fs"),
      currentGeneration: null,
      lastRefreshAt: null,
    });
    await expect(loader.getTone()).resolves.toMatchObject({ markdown: "lazy-tone" });
    expect(loader.status()).toMatchObject({
      cacheDir: join(stateDir, "cache", "test-adapter"),
      lastError: null,
    });
  });

  it("uses the default filesystem config when config.json is missing and honors WINGMAN_X_STATE_DIR", async () => {
    const stateDir = tempStateDir();
    seedDefaultFsKB(stateDir);
    const logs: Array<Record<string, unknown>> = [];

    const loader = createKBLoader({
      now: () => new Date("2026-05-25T04:00:00.000Z"),
      log: (event) => logs.push(event),
    });
    await loader.refresh();

    expect(await loader.getTone()).toMatchObject({ markdown: "# Default tone\n" });
    expect((await loader.listLibrary()).map((entry) => entry.id)).toEqual(["agents"]);
    expect((await loader.getLibraryEntry("agents")).markdown).toContain("Agent notes.");
    expect(await loader.getHandles()).toEqual({ tiers: [] });
    expect(loader.status()).toMatchObject({
      cacheDir: join(stateDir, "cache", "adapter-fs"),
      lastError: null,
    });
    expect(loader.status().currentGeneration).toEqual(expect.any(String));
    expect(logs).toContainEqual({
      event: "kb_config_default_used",
      reason: "missing",
    });
  });

  it("rejects malformed JSON config with CONFIG_INVALID and path detail", async () => {
    const stateDir = tempStateDir();
    writeFileSync(join(stateDir, "config.json"), "{not json", "utf8");

    const loader = createKBLoader();
    await expect(loader.refresh()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(loader.status().lastError).toMatchObject({ code: "CONFIG_INVALID" });
    expect(loader.status().lastError?.message).toContain(join(stateDir, "config.json"));
  });

  it("rejects config missing version with CONFIG_INVALID and zod path detail", async () => {
    const stateDir = tempStateDir();
    writeConfig(stateDir, {
      adapter: {
        package: "test-adapter",
        name: "test-adapter",
        config: {},
      },
    });

    const loader = createKBLoader({
      importModule: async () => adapterModule(makeAdapter({
        tone: { markdown: "unused", meta: {} },
        library: [],
        contents: {},
        handles: { tiers: [] },
      })),
    });
    await expect(loader.refresh()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(loader.status().lastError?.message).toContain("version");
  });

  it("rejects unknown adapter packages with CONFIG_INVALID", async () => {
    const stateDir = tempStateDir();
    writeConfig(stateDir, testConfig("@wingman-x/not-installed"));

    const loader = createKBLoader();
    await expect(loader.refresh()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(loader.status().lastError?.message).toContain("@wingman-x/not-installed");
  });

  it("rejects adapter modules without named createAdapter and configSchema exports", async () => {
    const stateDir = tempStateDir();
    writeConfig(stateDir, testConfig("shape-bad-adapter"));

    const loader = createKBLoader({
      importModule: async () => ({ createAdapter: () => undefined }),
    });
    await expect(loader.refresh()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(loader.status().lastError?.message).toContain("createAdapter");
    expect(loader.status().lastError?.message).toContain("configSchema");
  });

  it("rejects createAdapter results that do not implement the adapter contract", async () => {
    const stateDir = tempStateDir();
    writeConfig(stateDir, testConfig("invalid-result-adapter"));

    const loader = createKBLoader({
      importModule: async () => ({
        configSchema: z.record(z.string(), z.unknown()),
        createAdapter: () => ({ schemaVersion: "1" }),
      }),
    });
    await expect(loader.refresh()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(loader.status().lastError?.message).toContain("invalid adapter shape");
  });

  it("rejects adapter-side config schema failures with adapter and issue detail", async () => {
    const stateDir = tempStateDir();
    writeConfig(stateDir, {
      version: 1,
      adapter: {
        package: "rejecting-adapter",
        name: "rejecting-adapter",
        config: {},
      },
    });

    const loader = createKBLoader({
      importModule: async () => ({
        configSchema: z.object({ requiredPath: z.string().min(1) }),
        createAdapter: () =>
          makeAdapter({
            tone: { markdown: "unused", meta: {} },
            library: [],
            contents: {},
            handles: { tiers: [] },
          }),
      }),
    });

    await expect(loader.refresh()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(loader.status().lastError?.adapter).toBe("rejecting-adapter");
    expect(loader.status().lastError?.message).toContain("requiredPath");
  });
});

describe("KB loader cache behavior", () => {
  it("serves cached data after refresh and refreshes stale cache in the background", async () => {
    const stateDir = tempStateDir();
    writeConfig(stateDir, testConfig());
    let now = new Date("2026-05-25T05:00:00.000Z");
    const logs: Array<Record<string, unknown>> = [];
    const state: MutableAdapterState = {
      tone: { markdown: "tone-v1", meta: {} },
      library: [{ id: "alpha", title: "Alpha" }],
      contents: { alpha: { id: "alpha", title: "Alpha", markdown: "# Alpha" } },
      handles: { tiers: [] },
    };
    const adapter = makeAdapter(state);
    const loader = createKBLoader({
      ttlSeconds: 1,
      now: () => now,
      log: (event) => logs.push(event),
      importModule: async () => adapterModule(adapter),
    });

    await loader.refresh();
    expect(await loader.getTone()).toMatchObject({ markdown: "tone-v1" });
    expect(adapter.getTone).toHaveBeenCalledTimes(1);

    state.tone = { markdown: "tone-v2", meta: {} };
    state.library = [{ id: "beta", title: "Beta" }];
    state.contents = { beta: { id: "beta", title: "Beta", markdown: "# Beta" } };
    now = new Date("2026-05-25T05:00:02.000Z");

    await expect(loader.getTone()).resolves.toMatchObject({ markdown: "tone-v1" });
    await waitForAssertion(async () => {
      expect(await loader.getTone()).toMatchObject({ markdown: "tone-v2" });
    });
    expect((await loader.listLibrary()).map((entry) => entry.id)).toEqual(["beta"]);
    expect(logs.some((event) => event.event === "kb_cache_refresh_failed")).toBe(false);

    state.fail = new KBAdapterError("SOURCE_UNAVAILABLE", "test-adapter", "source offline");
    const currentGeneration = loader.status().currentGeneration;
    now = new Date("2026-05-25T05:00:04.000Z");
    await expect(loader.getTone()).resolves.toMatchObject({ markdown: "tone-v2" });

    await waitForAssertion(() => {
      expect(loader.status().lastError).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    });
    expect(loader.status().currentGeneration).toBe(currentGeneration);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "kb_cache_refresh_failed",
        code: "SOURCE_UNAVAILABLE",
        adapter: "test-adapter",
      }),
    );
    const healthPath = join(
      loader.status().cacheDir,
      "generations",
      String(loader.status().currentGeneration),
      "health.json",
    );
    const health = JSON.parse(readFileSync(healthPath, "utf8"));
    expect(health.ok).toBe(false);
    expect(health.errors.join("\n")).toContain("SOURCE_UNAVAILABLE");
  });

  it("records PERMISSION_DENIED and UNKNOWN refresh errors without flipping CURRENT", async () => {
    const stateDir = tempStateDir();
    writeConfig(stateDir, testConfig());
    const state: MutableAdapterState = {
      tone: { markdown: "tone-ok", meta: {} },
      library: [{ id: "alpha", title: "Alpha" }],
      contents: { alpha: { id: "alpha", title: "Alpha", markdown: "# Alpha" } },
      handles: { tiers: [] },
    };
    const adapter = makeAdapter(state);
    const loader = createKBLoader({
      importModule: async () => adapterModule(adapter),
    });

    await loader.refresh();
    const originalGeneration = loader.status().currentGeneration;

    state.fail = new KBAdapterError("PERMISSION_DENIED", "test-adapter", "no permission");
    await expect(loader.refresh()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(loader.status().currentGeneration).toBe(originalGeneration);
    expect(loader.status().lastError).toMatchObject({ code: "PERMISSION_DENIED" });

    state.fail = new KBAdapterError("UNKNOWN", "test-adapter", "unknown failure");
    await expect(loader.refresh()).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(loader.status().currentGeneration).toBe(originalGeneration);
    const health = JSON.parse(
      readFileSync(
        join(
          loader.status().cacheDir,
          "generations",
          String(loader.status().currentGeneration),
          "health.json",
        ),
        "utf8",
      ),
    );
    expect(health.ok).toBe(false);
    expect(health.errors.join("\n")).toContain("UNKNOWN");
  });

  it("skips library entries whose content read returns NOT_FOUND", async () => {
    const stateDir = tempStateDir();
    writeConfig(stateDir, testConfig());
    const adapter = makeAdapter({
      tone: { markdown: "tone-ok", meta: {} },
      library: [
        { id: "keep", title: "Keep" },
        { id: "gone", title: "Gone" },
      ],
      contents: {
        keep: { id: "keep", title: "Keep", markdown: "# Keep" },
        gone: new KBAdapterError("NOT_FOUND", "test-adapter", "gone disappeared"),
      },
      handles: { tiers: [] },
    });
    const loader = createKBLoader({
      importModule: async () => adapterModule(adapter),
    });

    await loader.refresh();
    expect((await loader.listLibrary()).map((entry) => entry.id)).toEqual(["keep"]);
    await expect(loader.getLibraryEntry("gone")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("agent-kit dependency placement", () => {
  it("declares runtime KB dependencies in dependencies and has proper-lockfile installed", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve("package.json"), "utf8"),
    );

    for (const dependency of [
      "proper-lockfile",
      "@wingman-x/kb-contract",
      "@wingman-x/adapter-fs",
    ]) {
      expect(packageJson.dependencies).toHaveProperty(dependency);
      expect(packageJson.devDependencies ?? {}).not.toHaveProperty(dependency);
    }
    expect(packageJson.dependencies.zod).toBeDefined();
    expect(existsSync(resolve("../../node_modules/proper-lockfile/package.json"))).toBe(true);
  });
});
