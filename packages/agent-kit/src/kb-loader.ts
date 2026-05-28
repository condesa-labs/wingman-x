import { readFile } from "node:fs/promises";
import { ZodError } from "zod";
import {
  KBAdapterError,
  WingmanXConfigSchema,
  type AdapterModule,
  type HandleSet,
  type KBAdapter,
  type KBAdapterErrorCode,
  type LibraryContent,
  type LibraryEntry,
  type ToneResult,
  type WingmanXConfig,
} from "@winman-x/kb-contract";
import {
  createKBCache,
  type KBCache,
  type KBCacheHooks,
  type KBCachePayload,
  type KBCacheSnapshot,
} from "./kb-cache.js";
import {
  resolveKBCachePaths,
  resolveWingmanXConfigPath,
} from "./kb-paths.js";

export const DEFAULT_KB_CACHE_TTL_SECONDS = 900;

const DEFAULT_CONFIG: WingmanXConfig = {
  version: 1,
  adapter: {
    package: "@winman-x/adapter-fs",
    name: "adapter-fs",
    config: {},
  },
};

export interface KBLoaderStatus {
  cacheDir: string;
  currentGeneration: string | null;
  lastRefreshAt: string | null;
  lastError: KBAdapterError | null;
}

export interface KBLoaderOptions {
  ttlSeconds?: number;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
  importModule?: (specifier: string) => Promise<unknown>;
  randomSuffix?: () => string;
  cacheHooks?: KBCacheHooks;
}

export interface KBLoader {
  getTone(): Promise<ToneResult>;
  listLibrary(): Promise<LibraryEntry[]>;
  getLibraryEntry(id: string): Promise<LibraryContent>;
  getHandles(): Promise<HandleSet>;
  refresh(): Promise<void>;
  status(): KBLoaderStatus;
}

interface LoadedConfig {
  config: WingmanXConfig;
  configPath: string;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function zodIssueDetail(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "<root>: invalid value";
  }

  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
  return `${path}: ${issue.message}`;
}

function configInvalid(adapter: string, message: string): KBAdapterError {
  return new KBAdapterError("CONFIG_INVALID", adapter, message);
}

function toKBAdapterError(error: unknown, adapter: string): KBAdapterError {
  if (error instanceof KBAdapterError) {
    return error;
  }

  return new KBAdapterError("UNKNOWN", adapter, errorMessage(error));
}

function isAdapterModule(value: unknown): value is AdapterModule<unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    createAdapter?: unknown;
    configSchema?: { parse?: unknown };
  };
  return (
    typeof candidate.createAdapter === "function" &&
    candidate.configSchema !== undefined &&
    typeof candidate.configSchema.parse === "function"
  );
}

function isKBAdapter(value: unknown): value is KBAdapter {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Record<keyof KBAdapter, unknown>>;
  return (
    candidate.schemaVersion === "1" &&
    typeof candidate.name === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.getTone === "function" &&
    typeof candidate.listLibrary === "function" &&
    typeof candidate.getLibraryEntry === "function" &&
    typeof candidate.getHandles === "function" &&
    typeof candidate.healthCheck === "function"
  );
}

async function loadConfig(
  log: ((event: Record<string, unknown>) => void) | undefined,
): Promise<LoadedConfig> {
  const configPath = resolveWingmanXConfigPath();
  let raw: string;

  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      log?.({ event: "kb_config_default_used", reason: "missing" });
      return { config: DEFAULT_CONFIG, configPath };
    }
    throw configInvalid("config", `Unable to read WingmanX config at ${configPath}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw configInvalid("config", `Invalid JSON in WingmanX config at ${configPath}: ${errorMessage(error)}`);
  }

  try {
    return {
      config: WingmanXConfigSchema.parse(parsed),
      configPath,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw configInvalid(
        "config",
        `Invalid WingmanX config at ${configPath}: ${zodIssueDetail(error)}`,
      );
    }
    throw error;
  }
}

async function defaultImportModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

async function loadAdapter(
  loadedConfig: LoadedConfig,
  importModule: (specifier: string) => Promise<unknown>,
): Promise<KBAdapter> {
  const { config } = loadedConfig;
  let imported: unknown;

  try {
    imported = await importModule(config.adapter.package);
  } catch (error) {
    throw configInvalid(
      config.adapter.name,
      `Unable to import adapter package "${config.adapter.package}" from ${loadedConfig.configPath}: ${errorMessage(error)}`,
    );
  }

  if (!isAdapterModule(imported)) {
    throw configInvalid(
      config.adapter.name,
      `Adapter package "${config.adapter.package}" must export named createAdapter and configSchema`,
    );
  }

  let adapterConfig: unknown;
  try {
    adapterConfig = imported.configSchema.parse(config.adapter.config);
  } catch (error) {
    if (error instanceof ZodError) {
      throw configInvalid(
        config.adapter.name,
        `Invalid config for adapter "${config.adapter.name}": ${zodIssueDetail(error)}`,
      );
    }
    throw configInvalid(
      config.adapter.name,
      `Invalid config for adapter "${config.adapter.name}": ${errorMessage(error)}`,
    );
  }

  const adapter = imported.createAdapter(adapterConfig);
  if (!isKBAdapter(adapter)) {
    throw configInvalid(
      config.adapter.name,
      `Adapter package "${config.adapter.package}" createAdapter returned an invalid adapter shape`,
    );
  }

  return adapter;
}

function handleCount(handles: HandleSet): number {
  return handles.tiers.reduce((total, tier) => total + tier.handles.length, 0);
}

function computedHealth(
  tone: ToneResult,
  library: LibraryEntry[],
  handles: HandleSet,
): KBCachePayload["health"] {
  return {
    ok: true,
    stats: {
      libraryCount: library.length,
      handlesCount: handleCount(handles),
      toneBytes: Buffer.byteLength(tone.markdown, "utf8"),
    },
    warnings: [],
    errors: [],
  };
}

async function adapterPayload(adapter: KBAdapter, adapterName: string): Promise<KBCachePayload> {
  const tone = await adapter.getTone();
  const listedLibrary = await adapter.listLibrary();
  const library: LibraryEntry[] = [];
  const libraryContents: Record<string, LibraryContent> = {};

  for (const entry of listedLibrary) {
    try {
      libraryContents[entry.id] = await adapter.getLibraryEntry(entry.id);
      library.push(entry);
    } catch (error) {
      const kbError = toKBAdapterError(error, adapterName);
      if (kbError.code !== "NOT_FOUND") {
        throw kbError;
      }
    }
  }

  const handles = await adapter.getHandles();

  return {
    adapterVersion: adapter.version,
    tone,
    library,
    libraryContents,
    handles,
    health: computedHealth(tone, library, handles),
  };
}

function cloneArray<T>(items: T[]): T[] {
  return items.map((item) => ({ ...item }));
}

function cloneHandles(handles: HandleSet): HandleSet {
  return {
    tiers: handles.tiers.map((tier) => ({
      ...tier,
      handles: tier.handles.map((handle) => ({
        ...handle,
        ...(handle.tags !== undefined ? { tags: [...handle.tags] } : {}),
      })),
    })),
    ...(handles.meta !== undefined ? { meta: { ...handles.meta } } : {}),
  };
}

class KBLoaderImpl implements KBLoader {
  private snapshot: KBCacheSnapshot | null = null;
  private cache: KBCache | null = null;
  private adapterName = DEFAULT_CONFIG.adapter.name;
  private ttlSeconds = DEFAULT_KB_CACHE_TTL_SECONDS;
  private lastError: KBAdapterError | null = null;
  private backgroundRefresh: Promise<void> | null = null;

  constructor(private readonly options: KBLoaderOptions) {}

  async getTone(): Promise<ToneResult> {
    return (await this.snapshotForRead()).tone;
  }

  async listLibrary(): Promise<LibraryEntry[]> {
    return cloneArray((await this.snapshotForRead()).library);
  }

  async getLibraryEntry(id: string): Promise<LibraryContent> {
    const snapshot = await this.snapshotForRead();
    const entry = snapshot.libraryContents[id];
    if (entry === undefined) {
      throw new KBAdapterError("NOT_FOUND", this.adapterName, `Cached library entry not found: ${id}`);
    }
    return { ...entry };
  }

  async getHandles(): Promise<HandleSet> {
    return cloneHandles((await this.snapshotForRead()).handles);
  }

  async refresh(): Promise<void> {
    await this.refreshInternal(false);
  }

  status(): KBLoaderStatus {
    const cacheDir = this.cache?.paths.adapterCacheDir ?? resolveKBCachePaths(this.adapterName).adapterCacheDir;
    return {
      cacheDir,
      currentGeneration: this.snapshot?.generation ?? null,
      lastRefreshAt: this.snapshot?.writtenAt ?? null,
      lastError: this.lastError,
    };
  }

  private cacheFor(adapterName: string): KBCache {
    if (this.cache === null || this.adapterName !== adapterName) {
      this.adapterName = adapterName;
      this.cache = createKBCache({
        adapterName,
        now: this.options.now,
        randomSuffix: this.options.randomSuffix,
        hooks: this.options.cacheHooks,
      });
      this.snapshot = null;
    }

    return this.cache;
  }

  private async refreshInternal(background: boolean): Promise<void> {
    try {
      const loadedConfig = await loadConfig(this.options.log);
      const configTtl = loadedConfig.config.cache?.ttlSeconds ?? DEFAULT_KB_CACHE_TTL_SECONDS;
      this.ttlSeconds = this.options.ttlSeconds ?? configTtl;
      const cache = this.cacheFor(loadedConfig.config.adapter.name);
      const adapter = await loadAdapter(
        loadedConfig,
        this.options.importModule ?? defaultImportModule,
      );

      const snapshot = await cache.refresh(async () =>
        adapterPayload(adapter, loadedConfig.config.adapter.name),
      );
      this.snapshot = snapshot ?? (await cache.read());
      if (this.snapshot === null) {
        throw new KBAdapterError(
          "SOURCE_UNAVAILABLE",
          loadedConfig.config.adapter.name,
          `No KB cache is available at ${cache.paths.adapterCacheDir}`,
        );
      }
      this.lastError = null;
    } catch (error) {
      const kbError = toKBAdapterError(error, this.adapterName);
      this.lastError = kbError;
      await this.cache?.writeHealthFailure(kbError);
      if (background) {
        this.logRefreshFailure(kbError);
        return;
      }
      throw kbError;
    }
  }

  private snapshotIsStale(snapshot: KBCacheSnapshot): boolean {
    const currentTime = this.options.now?.() ?? new Date();
    return currentTime.getTime() - Date.parse(snapshot.writtenAt) > this.ttlSeconds * 1_000;
  }

  private async snapshotForRead(): Promise<KBCacheSnapshot> {
    if (this.snapshot === null) {
      await this.refresh();
    }

    if (this.snapshot === null) {
      throw new KBAdapterError("SOURCE_UNAVAILABLE", this.adapterName, "No KB cache snapshot is available");
    }

    const snapshot = this.snapshot;
    if (this.snapshotIsStale(snapshot)) {
      this.triggerBackgroundRefresh();
    }

    return snapshot;
  }

  private triggerBackgroundRefresh(): void {
    if (this.backgroundRefresh !== null) {
      return;
    }

    this.backgroundRefresh = this.refreshInternal(true).finally(() => {
      this.backgroundRefresh = null;
    });
    void this.backgroundRefresh;
  }

  private logRefreshFailure(error: KBAdapterError): void {
    const event: {
      event: string;
      code: KBAdapterErrorCode;
      adapter: string;
      message: string;
    } = {
      event: "kb_cache_refresh_failed",
      code: error.code,
      adapter: error.adapter,
      message: error.message,
    };
    this.options.log?.(event);
  }
}

export function createKBLoader(options: KBLoaderOptions = {}): KBLoader {
  return new KBLoaderImpl(options);
}
