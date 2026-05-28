import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  HandleSetSchema,
  HealthReportSchema,
  KBAdapterError,
  LibraryContentSchema,
  LibraryEntrySchema,
  ToneResultSchema,
  type HandleSet,
  type HealthReport,
  type LibraryContent,
  type LibraryEntry,
  type ToneResult,
} from "@winman-x/kb-contract";
import {
  resolveKBCachePaths,
  type KBAdapterCachePaths,
} from "./kb-paths.js";

const require = createRequire(import.meta.url);

interface ProperLockfileOptions {
  lockfilePath: string;
  realpath: false;
  stale: number;
  retries:
    | number
    | {
        retries: number;
        factor: number;
        minTimeout: number;
        maxTimeout: number;
      };
  onCompromised: (error: Error) => void;
}

const properLockfile = require("proper-lockfile") as {
  lock(path: string, options: ProperLockfileOptions): Promise<() => Promise<void>>;
};

export const CACHE_SCHEMA_VERSION = 1;
export const REFRESH_LOCK_STALE_MS = 60_000;

const CurrentSchema = z.object({
  generation: z.string().min(1),
  writtenAt: z.iso.datetime(),
  adapterVersion: z.string(),
  cacheSchemaVersion: z.number().int(),
});

const LibraryArraySchema = z.array(LibraryEntrySchema);
const LibraryContentsSchema = z.record(z.string(), LibraryContentSchema);

type CurrentPointer = z.infer<typeof CurrentSchema>;

export interface KBCachePayload {
  adapterVersion: string;
  tone: ToneResult;
  library: LibraryEntry[];
  libraryContents: Record<string, LibraryContent>;
  handles: HandleSet;
  health: HealthReport;
}

export interface KBCacheSnapshot extends KBCachePayload {
  generation: string;
  writtenAt: string;
  cacheSchemaVersion: number;
  cacheDir: string;
}

export interface KBCacheHooks {
  afterGenerationFilesWritten?: (generationDir: string) => void | Promise<void>;
}

export interface KBCacheOptions {
  adapterName: string;
  stateDir?: string;
  now?: () => Date;
  randomSuffix?: () => string;
  hooks?: KBCacheHooks;
}

export interface KBCache {
  readonly paths: KBAdapterCachePaths;
  read(): Promise<KBCacheSnapshot | null>;
  refresh(loadPayload: () => Promise<KBCachePayload>): Promise<KBCacheSnapshot | null>;
  writeHealthFailure(error: KBAdapterError): Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function sanitizeGenerationPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function generationTimestamp(now: () => Date): string {
  return sanitizeGenerationPart(nowIso(now));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(path, "utf8");
  return schema.parse(JSON.parse(raw));
}

async function readCurrent(paths: KBAdapterCachePaths): Promise<CurrentPointer | null> {
  try {
    return await readJson(paths.currentPath, CurrentSchema);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function writeJsonSynced(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizePayload(payload: KBCachePayload): KBCachePayload {
  return {
    adapterVersion: z.string().parse(payload.adapterVersion),
    tone: ToneResultSchema.parse(payload.tone),
    library: LibraryArraySchema.parse(payload.library),
    libraryContents: LibraryContentsSchema.parse(payload.libraryContents),
    handles: HandleSetSchema.parse(payload.handles),
    health: HealthReportSchema.parse(payload.health),
  };
}

async function writeGenerationFiles(
  generationDir: string,
  payload: KBCachePayload,
): Promise<void> {
  const normalized = normalizePayload(payload);
  await writeJsonSynced(join(generationDir, "tone.json"), normalized.tone);
  await writeJsonSynced(join(generationDir, "library.json"), normalized.library);
  await writeJsonSynced(
    join(generationDir, "library-contents.json"),
    normalized.libraryContents,
  );
  await writeJsonSynced(join(generationDir, "handles.json"), normalized.handles);
  await writeJsonSynced(join(generationDir, "health.json"), normalized.health);
}

async function readSnapshotFromCurrent(
  paths: KBAdapterCachePaths,
  current: CurrentPointer,
): Promise<KBCacheSnapshot> {
  const generationDir = join(paths.generationsDir, current.generation);
  return {
    generation: current.generation,
    writtenAt: current.writtenAt,
    adapterVersion: current.adapterVersion,
    cacheSchemaVersion: current.cacheSchemaVersion,
    cacheDir: paths.adapterCacheDir,
    tone: await readJson(join(generationDir, "tone.json"), ToneResultSchema),
    library: await readJson(join(generationDir, "library.json"), LibraryArraySchema),
    libraryContents: await readJson(
      join(generationDir, "library-contents.json"),
      LibraryContentsSchema,
    ),
    handles: await readJson(join(generationDir, "handles.json"), HandleSetSchema),
    health: await readJson(join(generationDir, "health.json"), HealthReportSchema),
  };
}

function generateSuffix(randomSuffix?: () => string): string {
  return randomSuffix?.() ?? randomBytes(6).toString("hex");
}

async function generateGenerationId(
  paths: KBAdapterCachePaths,
  now: () => Date,
  randomSuffix?: () => string,
): Promise<string> {
  const timestamp = generationTimestamp(now);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = sanitizeGenerationPart(generateSuffix(randomSuffix));
    const generation = attempt === 0
      ? `${timestamp}-${suffix}`
      : `${timestamp}-${suffix}-${attempt}`;
    if (!(await pathExists(join(paths.generationsDir, generation)))) {
      return generation;
    }
  }

  throw new Error("Unable to generate a unique KB cache generation id");
}

async function acquireRefreshLock(
  paths: KBAdapterCachePaths,
  waitForLock: boolean,
): Promise<(() => Promise<void>) | null> {
  try {
    return await properLockfile.lock(paths.lockPath, {
      lockfilePath: paths.lockPath,
      realpath: false,
      stale: REFRESH_LOCK_STALE_MS,
      retries: waitForLock
        ? {
            retries: Math.ceil(REFRESH_LOCK_STALE_MS / 1_000),
            factor: 1,
            minTimeout: 1_000,
            maxTimeout: 1_000,
          }
        : 0,
      onCompromised: () => undefined,
    });
  } catch (error) {
    if (isErrno(error, "ELOCKED")) {
      return null;
    }
    throw error;
  }
}

async function hasOlderCacheSchema(paths: KBAdapterCachePaths): Promise<boolean> {
  const current = await readCurrent(paths);
  return current !== null && current.cacheSchemaVersion < CACHE_SCHEMA_VERSION;
}

async function cleanupOlderGenerations(
  paths: KBAdapterCachePaths,
  currentGeneration: string,
): Promise<void> {
  const entries = await readdir(paths.generationsDir, { withFileTypes: true });
  const generations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  const keep = new Set<string>([currentGeneration]);
  for (const generation of generations) {
    if (keep.size >= 2) {
      break;
    }
    keep.add(generation);
  }

  await Promise.all(
    generations
      .filter((generation) => !keep.has(generation))
      .map((generation) =>
        rm(join(paths.generationsDir, generation), { recursive: true, force: true }),
      ),
  );
}

function formatHealthError(error: KBAdapterError): string {
  return `${error.code}: ${error.message}`;
}

function emptyStats(): HealthReport["stats"] {
  return {
    libraryCount: 0,
    handlesCount: 0,
    toneBytes: 0,
  };
}

export function createKBCache(options: KBCacheOptions): KBCache {
  const paths = resolveKBCachePaths(options.adapterName, options.stateDir);
  const now = options.now ?? (() => new Date());

  async function read(): Promise<KBCacheSnapshot | null> {
    const current = await readCurrent(paths);
    if (current === null) {
      return null;
    }

    return readSnapshotFromCurrent(paths, current);
  }

  async function refresh(
    loadPayload: () => Promise<KBCachePayload>,
  ): Promise<KBCacheSnapshot | null> {
    await mkdir(paths.cacheParent, { recursive: true });
    await mkdir(paths.adapterCacheDir, { recursive: true });
    await mkdir(paths.generationsDir, { recursive: true });

    const currentBeforeLock = await readCurrent(paths);
    const waitForLock = currentBeforeLock === null ||
      currentBeforeLock.cacheSchemaVersion < CACHE_SCHEMA_VERSION;
    const release = await acquireRefreshLock(paths, waitForLock);
    if (release === null) {
      return read();
    }

    try {
      if (await hasOlderCacheSchema(paths)) {
        await rm(paths.generationsDir, { recursive: true, force: true });
        await mkdir(paths.generationsDir, { recursive: true });
      }

      const payload = await loadPayload();
      const generation = await generateGenerationId(paths, now, options.randomSuffix);
      const generationDir = join(paths.generationsDir, generation);
      await mkdir(generationDir);
      await writeGenerationFiles(generationDir, payload);
      await options.hooks?.afterGenerationFilesWritten?.(generationDir);
      await fsyncDirectory(generationDir);

      const current: CurrentPointer = {
        generation,
        writtenAt: nowIso(now),
        adapterVersion: payload.adapterVersion,
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
      };
      await writeJsonSynced(paths.currentTmpPath, current);
      await rename(paths.currentTmpPath, paths.currentPath);
      await cleanupOlderGenerations(paths, generation);

      return readSnapshotFromCurrent(paths, current);
    } finally {
      await release();
    }
  }

  async function writeHealthFailure(error: KBAdapterError): Promise<void> {
    const current = await readCurrent(paths);
    if (current === null) {
      return;
    }

    const generationDir = join(paths.generationsDir, current.generation);
    let priorHealth: HealthReport | null = null;
    try {
      priorHealth = await readJson(join(generationDir, "health.json"), HealthReportSchema);
    } catch (readError) {
      if (!isErrno(readError, "ENOENT")) {
        throw readError;
      }
    }

    const health: HealthReport = {
      ok: false,
      stats: priorHealth?.stats ?? emptyStats(),
      warnings: priorHealth?.warnings ?? [],
      errors: [formatHealthError(error)],
    };

    await writeJsonSynced(join(generationDir, "health.json"), health);
    await fsyncDirectory(generationDir);
  }

  return {
    paths,
    read,
    refresh,
    writeHealthFailure,
  };
}
