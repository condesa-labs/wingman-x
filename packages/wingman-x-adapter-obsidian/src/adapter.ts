import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  KBAdapterError,
  parseHandles,
  slugify,
  type HandleSet,
  type HealthReport,
  type KBAdapter,
  type LibraryContent,
  type LibraryEntry,
  type ToneResult,
} from "@wingman-x/kb-contract";

import type { ObsidianConfig } from "./config.js";

const ADAPTER_NAME = "adapter-obsidian";
const ADAPTER_VERSION = "0.1.0";

interface VaultPaths {
  tonePath: string;
  libraryPath: string;
  handlesPath: string;
}

interface LoadedLibraryRecord {
  entry: LibraryEntry;
  content: LibraryContent;
  sourcePath: string;
}

function resolveVaultPaths(config: ObsidianConfig): VaultPaths {
  const rootPath = join(config.vaultPath, config.wingmanRoot);
  return {
    tonePath: join(rootPath, config.toneFile),
    libraryPath: join(rootPath, config.libraryFolder),
    handlesPath: join(rootPath, config.handlesFile),
  };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorCodeForSource(error: unknown): "SOURCE_UNAVAILABLE" | "PERMISSION_DENIED" {
  if (isErrnoException(error) && (error.code === "EACCES" || error.code === "EPERM")) {
    return "PERMISSION_DENIED";
  }

  return "SOURCE_UNAVAILABLE";
}

function sourceError(error: unknown, message: string): KBAdapterError {
  return new KBAdapterError(errorCodeForSource(error), ADAPTER_NAME, message);
}

async function readRequiredFile(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw sourceError(error, `Unable to read ${label}: ${path}`);
  }
}

async function readLibrarySourceNames(libraryPath: string): Promise<string[]> {
  try {
    const dirents = await readdir(libraryPath, { withFileTypes: true });
    return dirents
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".md"))
      .map((dirent) => dirent.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    throw sourceError(error, `Unable to read library directory: ${libraryPath}`);
  }
}

function deriveLibraryId(sourcePath: string): string {
  const id = slugify(basename(sourcePath, ".md"));
  if (id.length === 0) {
    throw new KBAdapterError(
      "CONFIG_INVALID",
      ADAPTER_NAME,
      `Library source derives an empty id: ${sourcePath}`,
    );
  }
  return id;
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(markdown);
  return heading?.[1]?.trim() || fallback;
}

async function loadLibrary(paths: VaultPaths): Promise<LoadedLibraryRecord[]> {
  const fileNames = await readLibrarySourceNames(paths.libraryPath);
  const byId = new Map<string, LoadedLibraryRecord>();

  for (const fileName of fileNames) {
    const sourcePath = join(paths.libraryPath, fileName);
    const id = deriveLibraryId(sourcePath);
    const existing = byId.get(id);
    if (existing !== undefined) {
      throw new KBAdapterError(
        "CONFIG_INVALID",
        ADAPTER_NAME,
        `Library id "${id}" is derived from both ${existing.sourcePath} and ${sourcePath}`,
      );
    }

    const markdown = await readRequiredFile(sourcePath, "library source");
    const entry: LibraryEntry = {
      id,
      title: titleFromMarkdown(markdown, id),
    };
    byId.set(id, {
      entry,
      content: { ...entry, markdown },
      sourcePath,
    });
  }

  return [...byId.values()].sort((left, right) => left.entry.id.localeCompare(right.entry.id));
}

function toHealthError(error: unknown): string {
  if (error instanceof KBAdapterError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function handlesCount(handles: HandleSet): number {
  return handles.tiers.reduce((total, tier) => total + tier.handles.length, 0);
}

export function createAdapter(config: ObsidianConfig): KBAdapter {
  const paths = resolveVaultPaths(config);

  async function getTone(): Promise<ToneResult> {
    const markdown = await readRequiredFile(paths.tonePath, "tone source");
    return {
      markdown,
      meta: {
        source: paths.tonePath,
      },
    };
  }

  async function listLibrary(): Promise<LibraryEntry[]> {
    const records = await loadLibrary(paths);
    return records.map((record) => record.entry);
  }

  async function getLibraryEntry(id: string): Promise<LibraryContent> {
    const records = await loadLibrary(paths);
    const record = records.find((candidate) => candidate.entry.id === id);
    if (record === undefined) {
      throw new KBAdapterError("NOT_FOUND", ADAPTER_NAME, `Library entry not found: ${id}`);
    }
    return record.content;
  }

  async function getHandles(): Promise<HandleSet> {
    const markdown = await readRequiredFile(paths.handlesPath, "handles source");
    return parseHandles(markdown, ADAPTER_NAME);
  }

  async function healthCheck(): Promise<HealthReport> {
    const errors: string[] = [];
    let libraryCount = 0;
    let handlesTotal = 0;
    let toneBytes = 0;

    try {
      const tone = await getTone();
      toneBytes = Buffer.byteLength(tone.markdown, "utf8");
    } catch (error) {
      errors.push(toHealthError(error));
    }

    try {
      libraryCount = (await listLibrary()).length;
    } catch (error) {
      errors.push(toHealthError(error));
    }

    try {
      handlesTotal = handlesCount(await getHandles());
    } catch (error) {
      errors.push(toHealthError(error));
    }

    return {
      ok: errors.length === 0,
      stats: {
        libraryCount,
        handlesCount: handlesTotal,
        toneBytes,
      },
      warnings: [],
      errors,
    };
  }

  return {
    schemaVersion: "1",
    name: ADAPTER_NAME,
    version: ADAPTER_VERSION,
    displayName: "Obsidian",
    healthCheck,
    getTone,
    listLibrary,
    getLibraryEntry,
    getHandles,
  };
}
