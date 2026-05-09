import { lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export type Topic = "ai" | "investing" | "productivity";

export interface MarkdownNote {
  relativePath: string;
  content: string;
}

export interface CollectOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  log?: (line: string) => void;
}

export const TOPIC_FILENAMES: Record<Topic, string> = {
  ai: "ai.md",
  investing: "investing.md",
  productivity: "productivity.md",
};

const TOPIC_HEADINGS: Record<Topic, string> = {
  ai: "AI",
  investing: "Investing",
  productivity: "Productivity",
};

const TOPIC_KEYWORDS: Record<Topic, readonly string[]> = {
  ai: [
    "ai",
    "agent",
    "agents",
    "artificial intelligence",
    "benchmark",
    "eval",
    "evaluation",
    "llm",
    "model",
    "prompt",
    "retrieval",
    "rag",
    "人工智能",
    "大模型",
    "模型",
    "智能体",
  ],
  investing: [
    "a股",
    "allocation",
    "asset",
    "bond",
    "cash",
    "equities",
    "equity",
    "fund",
    "index",
    "investing",
    "investment",
    "macro",
    "market",
    "portfolio",
    "position",
    "risk",
    "valuation",
    "估值",
    "债券",
    "基金",
    "投资",
    "现金流",
    "行业",
    "资产",
    "配置",
  ],
  productivity: [
    "automation",
    "calendar",
    "checklist",
    "deep work",
    "efficiency",
    "focus",
    "inbox",
    "productivity",
    "review",
    "script",
    "task",
    "workflow",
    "专注",
    "效率",
    "清单",
    "自动化",
  ],
};

const TOPIC_ORDER: readonly Topic[] = ["ai", "investing", "productivity"];
const MAX_NOTES_PER_TOPIC = 8;
const MAX_WORDS_PER_NOTE = 140;

export function classifyNote(note: MarkdownNote): Topic[] {
  const haystack = `${note.relativePath}\n${note.content}`.toLowerCase();
  if (/\bshould not be selected\b|\bdoes not discuss\b/.test(haystack)) {
    return [];
  }

  return TOPIC_ORDER.filter((topic) => {
    const score = TOPIC_KEYWORDS[topic].reduce(
      (total, keyword) => total + countOccurrences(haystack, keyword),
      0,
    );
    return score >= 2;
  });
}

export async function collectMarkdownNotes(
  vaultPath: string,
  options: CollectOptions = {},
): Promise<MarkdownNote[]> {
  const root = await realDirectory(vaultPath);
  const maxFiles = options.maxFiles ?? 10_000;
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const found: string[] = [];
  let seenFiles = 0;

  async function visit(dir: string): Promise<void> {
    if (seenFiles >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (seenFiles >= maxFiles) break;
      const fullPath = join(dir, entry.name);
      const relativePath = normalizePath(relative(root, fullPath));
      if (shouldSkipPath(relativePath, entry.name)) continue;
      if (entry.isSymbolicLink()) {
        options.log?.(
          JSON.stringify({
            event: "kb_seed_skipped",
            reason: "symlink",
            path: relativePath,
          }),
        );
        continue;
      }
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (entry.isFile()) {
        seenFiles += 1;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const fileStat = await stat(fullPath);
      if (fileStat.size > maxFileBytes) {
        options.log?.(
          JSON.stringify({
            event: "kb_seed_skipped",
            reason: "file_too_large",
            path: relativePath,
            bytes: fileStat.size,
            max_bytes: maxFileBytes,
          }),
        );
        continue;
      }
      found.push(fullPath);
    }
  }

  await visit(root);
  if (seenFiles >= maxFiles) {
    options.log?.(
      JSON.stringify({
        event: "kb_seed_file_cap_reached",
        max_files: maxFiles,
      }),
    );
  }

  const notes = await Promise.all(
    found.map(async (fullPath) => ({
      relativePath: normalizePath(relative(root, fullPath)),
      content: await readFile(fullPath, "utf8"),
    })),
  );
  return notes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function buildLibraryMarkdown(
  notes: readonly MarkdownNote[],
): Record<Topic, string> {
  const buckets: Record<Topic, MarkdownNote[]> = {
    ai: [],
    investing: [],
    productivity: [],
  };

  for (const note of [...notes].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    for (const topic of classifyNote(note)) {
      buckets[topic].push(note);
    }
  }

  return Object.fromEntries(
    TOPIC_ORDER.map((topic) => [
      topic,
      renderTopicMarkdown(topic, buckets[topic]),
    ]),
  ) as Record<Topic, string>;
}

export async function writeLibraryMarkdown(
  outPath: string,
  markdownByTopic: Record<Topic, string>,
): Promise<void> {
  await mkdir(outPath, { recursive: true });
  for (const topic of TOPIC_ORDER) {
    await writeFile(join(outPath, TOPIC_FILENAMES[topic]), markdownByTopic[topic], "utf8");
  }
}

export function countMarkdownWords(markdown: string): number {
  const latinWords = markdown.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) ?? [];
  const cjkChars = markdown.match(/[\u3400-\u9fff]/g) ?? [];
  return latinWords.length + cjkChars.length;
}

function renderTopicMarkdown(topic: Topic, notes: readonly MarkdownNote[]): string {
  const sections = notes.slice(0, MAX_NOTES_PER_TOPIC).map((note) => {
    const body = stripFrontmatterAndHeading(note.content).trim();
    return [
      `## ${note.relativePath}`,
      "",
      excerptWords(body, MAX_WORDS_PER_NOTE),
    ].join("\n").trim();
  });

  const content =
    sections.length > 0
      ? sections.join("\n\n")
      : "No matching source notes were found in the configured vault.";

  return `# ${TOPIC_HEADINGS[topic]}\n\n${content}\n`;
}

function stripFrontmatterAndHeading(content: string): string {
  const withoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n/u, "");
  return withoutFrontmatter.replace(/^# .*(?:\n|$)/u, "");
}

function excerptWords(content: string, maxWords: number): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "";
  const words = normalized.split(" ");
  const excerpt = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${excerpt}...` : excerpt;
}

function countOccurrences(haystack: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = /^[a-z0-9 ]+$/i.test(needle)
    ? new RegExp(`\\b${escaped}\\b`, "gu")
    : new RegExp(escaped, "gu");
  return haystack.match(pattern)?.length ?? 0;
}

function normalizePath(path: string): string {
  return path.split("\\").join("/");
}

function shouldSkipPath(relativePath: string, entryName: string): boolean {
  if (entryName.startsWith(".")) return true;
  const topLevel = relativePath.split("/")[0] ?? "";
  return /^(00_|01_|02_)/u.test(topLevel);
}

async function realDirectory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`vault is not a real directory: ${path}`);
  }
  return path;
}
