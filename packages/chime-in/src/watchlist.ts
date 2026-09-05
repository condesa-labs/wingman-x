import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Watchlist: the accounts we scan. Only `handle` is required. Priority
 * 1 = important, 2 = normal (default), 3 = peripheral. Category and
 * notes are free text and currently informational (Phase 2 ranking).
 */
export const WatchAccountSchema = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/, "X handle, no @"),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  category: z.string().optional(),
  notes: z.string().optional(),
});
export type WatchAccount = z.infer<typeof WatchAccountSchema>;

const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;

/** Minimal CSV field splitter (handles double-quoted fields with commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parsePriority(v: string | undefined): 1 | 2 | 3 {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "" ) return 2;
  if (t === "1" || t === "important" || t === "high") return 1;
  if (t === "3" || t === "peripheral" || t === "low") return 3;
  if (t === "2" || t === "normal" || t === "medium") return 2;
  throw new Error(`invalid priority ${JSON.stringify(v)} (use 1, 2, or 3)`);
}

/**
 * Accepts either:
 *   - a CSV with a header row containing `handle` (and optionally
 *     `priority`, `category`, `notes`), or
 *   - one handle per line (`@handle` or `handle`), optionally followed by
 *     `,priority,category,notes` positionally.
 * Lines starting with `#` are comments. Duplicate handles keep the first.
 */
export function parseWatchlist(text: string): WatchAccount[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];

  let columns = ["handle", "priority", "category", "notes"];
  let start = 0;
  const headerCells = splitCsvLine(lines[0]!).map((c) => c.toLowerCase());
  if (headerCells.includes("handle")) {
    columns = headerCells;
    start = 1;
  }

  const seen = new Set<string>();
  const out: WatchAccount[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    columns.forEach((col, idx) => {
      row[col] = cells[idx] ?? "";
    });
    const handleMatch = HANDLE_RE.exec(row.handle ?? "");
    if (!handleMatch?.[1]) {
      throw new Error(`watchlist line ${i + 1}: invalid handle ${JSON.stringify(row.handle)}`);
    }
    const handle = handleMatch[1];
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const account: WatchAccount = { handle, priority: parsePriority(row.priority) };
    if (row.category) account.category = row.category;
    if (row.notes) account.notes = row.notes;
    out.push(WatchAccountSchema.parse(account));
  }
  return out;
}

export async function loadWatchlist(path: string): Promise<WatchAccount[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `watchlist not found at ${path}. Create it with one handle per line (or a CSV with a "handle" column). Run "npm run kb:init" to scaffold an example.`,
      );
    }
    throw err;
  }
  const accounts = parseWatchlist(text);
  if (accounts.length === 0) {
    throw new Error(`watchlist at ${path} is empty`);
  }
  return accounts;
}
