import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { serializeHandles, type HandleSet, type HandleTier } from "@winman-x/kb-contract";

export interface MigrateTwitterHelperKBOptions {
  sourceDir?: string;
  targetDir?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface MigrateTwitterHelperKBResult {
  status: "migrated" | "skipped";
  sourceDir: string;
  targetDir: string;
  libraryFiles: number;
  handlesTiers: number;
  message: string;
}

interface LibraryPlan {
  filename: string;
  markdown: string;
}

interface MigrationPlan {
  toneMarkdown: string;
  library: LibraryPlan[];
  handlesMarkdown: string;
  handlesTiers: number;
}

const LEGACY_KB_PATH = "~/.twitter-helper/kb";
const WINGMAN_X_KB_PATH = "~/.wingman-x/kb";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const TIER_DEFAULTS: Record<1 | 2 | 3, Pick<HandleTier, "label" | "policy">> = {
  1: { label: "Core handles", policy: "every-run" },
  2: { label: "Rotation handles", policy: "sampled" },
  3: { label: "Manual handles", policy: "manual" },
};

export async function migrateTwitterHelperKB(
  options: MigrateTwitterHelperKBOptions = {},
): Promise<MigrateTwitterHelperKBResult> {
  const sourceDir = expandPath(options.sourceDir ?? LEGACY_KB_PATH);
  const targetDir = expandPath(options.targetDir ?? WINGMAN_X_KB_PATH);
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});

  if (await pathExists(targetDir)) {
    const message = `migration skipped: target already exists at ${targetDir}`;
    log(message);
    return {
      status: "skipped",
      sourceDir,
      targetDir,
      libraryFiles: 0,
      handlesTiers: 0,
      message,
    };
  }

  const plan = await buildMigrationPlan(sourceDir, warn);
  const tmpDir = join(
    dirname(targetDir),
    `.kb-migrate-${basename(targetDir)}-${process.pid}-${Date.now()}.tmp`,
  );

  try {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(join(tmpDir, "library"), { recursive: true });
    await writeFile(join(tmpDir, "tone.md"), plan.toneMarkdown, "utf8");
    for (const item of plan.library) {
      await writeFile(join(tmpDir, "library", item.filename), item.markdown, "utf8");
    }
    await writeFile(join(tmpDir, "handles.md"), plan.handlesMarkdown, "utf8");
    await mkdir(dirname(targetDir), { recursive: true });
    await rename(tmpDir, targetDir);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  const message = `migration complete: source=${sourceDir} target=${targetDir} library_files=${plan.library.length} handles_tiers=${plan.handlesTiers}`;
  log(message);
  return {
    status: "migrated",
    sourceDir,
    targetDir,
    libraryFiles: plan.library.length,
    handlesTiers: plan.handlesTiers,
    message,
  };
}

async function buildMigrationPlan(
  sourceDir: string,
  warn: (line: string) => void,
): Promise<MigrationPlan> {
  const toneMarkdown = await readUtf8Markdown(join(sourceDir, "tone.md"));
  const library = await buildLibraryPlan(join(sourceDir, "library"));
  const handles = await buildHandlesMarkdown(sourceDir, warn);

  return {
    toneMarkdown,
    library,
    handlesMarkdown: handles.markdown,
    handlesTiers: handles.tiers,
  };
}

async function buildLibraryPlan(libraryDir: string): Promise<LibraryPlan[]> {
  if (!(await pathExists(libraryDir))) {
    return [];
  }

  const entries = await readdir(libraryDir, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const planned: LibraryPlan[] = [];
  for (const entry of markdownFiles) {
    const sourcePath = join(libraryDir, entry.name);
    const [content, info] = await Promise.all([
      readUtf8Markdown(sourcePath),
      stat(sourcePath),
    ]);
    planned.push({
      filename: entry.name,
      markdown: injectLibraryFrontmatter(content, info.mtime.toISOString()),
    });
  }

  return planned;
}

async function buildHandlesMarkdown(
  sourceDir: string,
  warn: (line: string) => void,
): Promise<{ markdown: string; tiers: number }> {
  const handlesPath = join(sourceDir, "selected-handles.txt");
  if (!(await pathExists(handlesPath))) {
    warn(`migration warning: selected-handles.txt missing at ${handlesPath}; writing empty handles.md`);
    return {
      markdown: serializeHandles({ tiers: [] }),
      tiers: 0,
    };
  }

  const legacyMarkdown = await readUtf8Markdown(handlesPath);
  const handleSet = parseLegacySelectedHandles(legacyMarkdown);
  return {
    markdown: serializeHandles(handleSet),
    tiers: handleSet.tiers.length,
  };
}

function parseLegacySelectedHandles(markdown: string): HandleSet {
  const tiers = new Map<1 | 2 | 3, HandleTier>();
  let currentTier: 1 | 2 | 3 | undefined;

  for (const [index, rawLine] of markdown.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }

    const header = /^##\s*Tier\s+([123])\b/iu.exec(line);
    if (header) {
      currentTier = Number(header[1]) as 1 | 2 | 3;
      if (!tiers.has(currentTier)) {
        tiers.set(currentTier, {
          tier: currentTier,
          ...TIER_DEFAULTS[currentTier],
          handles: [],
        });
      }
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (currentTier === undefined) {
      throw new Error(`selected-handles.txt line ${index + 1}: handle appears before a tier header`);
    }

    const handle = line.startsWith("@") ? line.slice(1) : line;
    if (!/^[A-Za-z0-9_]{1,15}$/u.test(handle)) {
      throw new Error(`selected-handles.txt line ${index + 1}: invalid handle "${line}"`);
    }

    tiers.get(currentTier)?.handles.push({ handle });
  }

  return {
    tiers: ([1, 2, 3] as const).flatMap((tier) => {
      const value = tiers.get(tier);
      return value === undefined ? [] : [value];
    }),
  };
}

function injectLibraryFrontmatter(markdown: string, updatedAt: string): string {
  return [
    "---",
    "tags: []",
    'summary: ""',
    `updated_at: ${updatedAt}`,
    'source_note: ""',
    "---",
    markdown,
  ].join("\n");
}

async function readUtf8Markdown(path: string): Promise<string> {
  const buffer = await readFile(path);
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw new Error(`invalid UTF-8 in migrated markdown source: ${path}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}
