#!/usr/bin/env tsx
/**
 * `npm run kb:sync-x -- --handle <handle> [--max 400] [--from-file dump.json]`
 *
 * Pull an account's authored X posts (originals, replies, quotes) and merge
 * them into `<kb>/sources/x/<handle>.jsonl`, deduplicated by id. This is
 * source material for (re)writing `tone.md` with the Meng-style voice
 * analysis: replies teach conversational phrasing, originals teach
 * structure, quotes teach reaction. Nothing under `sources/` is read at
 * scan time — Wingman's adapter only loads `tone.md` and `library/*.md`.
 *
 * `--from-file` ingests a raw Apify dump instead of calling the actor.
 */
import "../../../scripts/load-env.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { resolveWingmanXStateDir } from "../src/paths.js";
import { createApifyClientRunner } from "../src/sources/apify/apify-client-runner.js";
import { inferInputStyle } from "../src/sources/apify/apify-source.js";

interface HistoryItem {
  id: string;
  url?: string;
  date: string;
  type: "original" | "reply" | "quote";
  text: string;
  in_reply_to?: string;
  quoted_text?: string;
  likes?: number;
  replies?: number;
  views?: number;
}

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const handle = (flag("--handle") ?? "").replace(/^@/, "");
const max = Number(flag("--max") ?? "400");
const fromFile = flag("--from-file");
if (!handle) {
  process.stderr.write("usage: npm run kb:sync-x -- --handle <x_handle> [--max 400] [--from-file dump.json]\n");
  process.exit(1);
}

type Rec = Record<string, unknown>;
const s = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined);

function toItem(raw: Rec): HistoryItem | null {
  const author = (s(raw.authorHandle) ?? s((raw.author as Rec | undefined)?.userName) ?? "").toLowerCase();
  if (author !== handle.toLowerCase()) return null;
  if (raw.isRetweet === true) return null;
  const id = s(raw.tweetId) ?? s(raw.id);
  const text = s(raw.fullText) ?? s(raw.text);
  const createdAt = s(raw.createdAt);
  if (!id || !text || !createdAt) return null;
  let t = Date.parse(createdAt);
  if (!Number.isFinite(t)) t = Date.parse(createdAt.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, "$1T$2"));
  const item: HistoryItem = {
    id,
    date: Number.isFinite(t) ? new Date(t).toISOString() : createdAt,
    type: raw.isReply === true ? "reply" : raw.isQuote === true ? "quote" : "original",
    text,
  };
  const url = s(raw.tweetUrl) ?? s(raw.url);
  if (url) item.url = url;
  const irt = s(raw.inReplyToHandle) ?? s(raw.inReplyToUsername);
  if (irt) item.in_reply_to = irt.replace(/^@/, "");
  const qt = s(raw.quotedText);
  if (qt) item.quoted_text = qt;
  const likes = n(raw.likeCount);
  if (likes !== undefined) item.likes = likes;
  const replies = n(raw.replyCount);
  if (replies !== undefined) item.replies = replies;
  const views = n(raw.viewCount);
  if (views !== undefined) item.views = views;
  return item;
}

function parseJsonl(text: string): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as HistoryItem;
      if (v && typeof v.id === "string" && typeof v.text === "string") out.push(v);
    } catch {
      // torn line
    }
  }
  return out;
}

async function fetchItems(): Promise<unknown[]> {
  if (fromFile) return JSON.parse(readFileSync(fromFile, "utf8")) as unknown[];
  const config = loadConfig();
  if (!config.apifyToken) throw new Error("APIFY_TOKEN is not set");
  const style = inferInputStyle(config.apifyActor);
  const input =
    style === "zebu"
      ? { searchTerms: [`from:${handle}`], sortBy: "Latest", excludeReplies: false, maxItems: max }
      : { searchTerms: [`from:${handle}`], sort: "Latest", maxItems: max };
  const run = createApifyClientRunner({
    token: config.apifyToken,
    actorId: config.apifyActor,
    timeoutSecs: config.apifyTimeoutSecs,
    log: (l) => process.stdout.write(`${l}\n`),
  });
  return run(input);
}

const items = await fetchItems();
const fresh = items.map((r) => toItem(r as Rec)).filter((x): x is HistoryItem => x !== null);
const dir = join(resolveWingmanXStateDir(), "kb", "sources", "x");
mkdirSync(dir, { recursive: true });
const path = join(dir, `${handle.toLowerCase()}.jsonl`);
const existing = existsSync(path) ? parseJsonl(readFileSync(path, "utf8")) : [];
const byId = new Map(existing.map((e) => [e.id, e] as const));
let added = 0;
for (const f of fresh) {
  if (!byId.has(f.id)) added += 1;
  byId.set(f.id, f);
}
const merged = [...byId.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
writeFileSync(path, merged.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
const counts = { original: 0, reply: 0, quote: 0 };
for (const m of merged) counts[m.type] += 1;
process.stdout.write(
  `${items.length} raw item(s) → ${fresh.length} authored by @${handle}; ${added} new. History now ${merged.length} (${JSON.stringify(counts)}) at ${path}\n`,
);
