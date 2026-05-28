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
} from "@winman-x/kb-contract";

import type { FsConfig } from "./config.js";
import { resolveRootPath } from "./config.js";

const ADAPTER_NAME = "adapter-fs";
const ADAPTER_VERSION = "0.1.0";

interface LoadedLibraryRecord {
  entry: LibraryEntry;
  content: LibraryContent;
  sourcePath: string;
  searchableText: string;
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

function isMissingSource(error: unknown): boolean {
  return isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function readRequiredFile(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw sourceError(error, `Unable to read ${label}: ${path}`);
  }
}

async function readOptionalHandles(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingSource(error)) {
      return undefined;
    }
    throw sourceError(error, `Unable to read handles source: ${path}`);
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
  const id = slugify(basename(sourcePath, ".md").toLowerCase());
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

async function loadLibrary(rootPath: string): Promise<LoadedLibraryRecord[]> {
  const libraryPath = join(rootPath, "library");
  const fileNames = await readLibrarySourceNames(libraryPath);
  const byId = new Map<string, LoadedLibraryRecord>();

  for (const fileName of fileNames) {
    const sourcePath = join(libraryPath, fileName);
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
      searchableText: `${entry.id}\n${entry.title}\n${markdown}`.toLowerCase(),
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

function scoreSearchRecord(record: LoadedLibraryRecord, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (!record.searchableText.includes(term)) {
      return 0;
    }
    if (record.entry.id.includes(term)) {
      score += 6;
    }
    if (record.entry.title.toLowerCase().includes(term)) {
      score += 4;
    }
    score += record.searchableText.split(term).length - 1;
  }
  return score;
}

export function createAdapter(_config: FsConfig): KBAdapter {
  const rootPath = resolveRootPath(_config);

  async function getTone(): Promise<ToneResult> {
    const markdown = await readRequiredFile(join(rootPath, "tone.md"), "tone source");
    return {
      markdown,
      meta: {
        source: join(rootPath, "tone.md"),
      },
    };
  }

  async function listLibrary(): Promise<LibraryEntry[]> {
    const records = await loadLibrary(rootPath);
    return records.map((record) => record.entry);
  }

  async function getLibraryEntry(id: string): Promise<LibraryContent> {
    const records = await loadLibrary(rootPath);
    const record = records.find((candidate) => candidate.entry.id === id);
    if (record === undefined) {
      throw new KBAdapterError("NOT_FOUND", ADAPTER_NAME, `Library entry not found: ${id}`);
    }
    return record.content;
  }

  async function searchLibrary(query: string, topK: number): Promise<LibraryEntry[]> {
    const limit = Math.max(0, Math.trunc(topK));
    if (limit === 0) {
      return [];
    }

    const records = await loadLibrary(rootPath);
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return records.slice(0, limit).map((record) => record.entry);
    }

    const terms = normalizedQuery.split(/\s+/).filter((term) => term.length > 0);
    return records
      .map((record) => ({ record, score: scoreSearchRecord(record, terms) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.record.entry.id.localeCompare(right.record.entry.id))
      .slice(0, limit)
      .map((result) => result.record.entry);
  }

  async function getHandles(): Promise<HandleSet> {
    const markdown = await readOptionalHandles(join(rootPath, "handles.md"));
    if (markdown === undefined) {
      return { tiers: [] };
    }
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
    displayName: "Filesystem",
    healthCheck,
    getTone,
    listLibrary,
    getLibraryEntry,
    searchLibrary,
    getHandles,
  };
}
