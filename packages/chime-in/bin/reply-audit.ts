#!/usr/bin/env tsx
/**
 * `npm run reply:audit -- --handles a,b,c [--max 80] [--since 2026-06-01]`
 *
 * Pulls RECENT REPLIES (not originals) for each handle and prints a
 * per-account reply profile: how many, how long, how many are links or
 * emoji, how many carry an argument, plus real samples. Used to pick
 * voice models for tone.md. Raw replies are saved to
 * `<kb>/sources/x-audit/<handle>.jsonl` so the pick can be revisited
 * without re-fetching.
 */
import "../../../scripts/load-env.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { resolveWingmanXStateDir } from "../src/paths.js";
import { createApifyClientRunner } from "../src/sources/apify/apify-client-runner.js";

interface Reply {
  id: string;
  date: string;
  text: string;
  in_reply_to?: string;
  likes: number;
  url?: string;
}

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const handles = (flag("--handles") ?? "").split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
if (handles.length === 0) {
  process.stderr.write("usage: npm run reply:audit -- --handles a,b,c [--max 80] [--since 2026-06-01]\n");
  process.exit(1);
}
const max = Number(flag("--max") ?? "80");
const since = flag("--since") ?? "2026-06-01";
const config = loadConfig();
if (!config.apifyToken) {
  process.stderr.write("APIFY_TOKEN is not set\n");
  process.exit(1);
}

type Rec = Record<string, unknown>;
const s = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const n = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);

const run = createApifyClientRunner({
  token: config.apifyToken,
  actorId: config.apifyActor,
  timeoutSecs: Math.max(config.apifyTimeoutSecs, 900),
  log: (l) => process.stderr.write(`${l}\n`),
});

// One search term per handle; zebu's maxItems is per search term.
const input = {
  searchTerms: handles.map((h) => `from:${h} filter:replies since:${since}`),
  sortBy: "Latest",
  startDate: since,
  excludeReplies: false,
  maxItems: max,
};
process.stderr.write(`actor ${config.apifyActor}\ninput ${JSON.stringify(input)}\n`);
const items = (await run(input)) as Rec[];

const byHandle = new Map<string, Reply[]>();
for (const raw of items) {
  const author = (s(raw.authorHandle) ?? "").toLowerCase();
  if (!author || raw.isRetweet === true) continue;
  const text = s(raw.fullText) ?? s(raw.text) ?? "";
  const id = s(raw.tweetId) ?? s(raw.id);
  if (!id || !text) continue;
  const list = byHandle.get(author) ?? [];
  const r: Reply = { id, date: s(raw.createdAt) ?? "", text, likes: n(raw.likeCount) };
  const irt = s(raw.inReplyToHandle) ?? s(raw.inReplyToUsername);
  if (irt) r.in_reply_to = irt.replace(/^@/, "");
  const url = s(raw.tweetUrl);
  if (url) r.url = url;
  list.push(r);
  byHandle.set(author, list);
}

const outDir = join(resolveWingmanXStateDir(), "kb", "sources", "x-audit");
mkdirSync(outDir, { recursive: true });

const stripMentions = (t: string): string => t.replace(/^(@\w+\s+)+/, "").trim();
const isLinkOnly = (t: string): boolean => /^(https?:\/\/\S+\s*)+$/.test(stripMentions(t));
const isTiny = (t: string): boolean => [...stripMentions(t)].length < 25;
const hasDash = (t: string): boolean => /[–—]|\s-\s/.test(t);
const pct = (a: number, b: number): string => (b === 0 ? "0%" : `${Math.round((100 * a) / b)}%`);
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s2 = [...xs].sort((a, b) => a - b);
  return s2[Math.floor(s2.length / 2)]!;
};

const rows: string[] = [];
for (const h of handles) {
  const list = (byHandle.get(h.toLowerCase()) ?? []).sort((a, b) => b.date.localeCompare(a.date));
  writeFileSync(join(outDir, `${h}.jsonl`), list.map((r) => JSON.stringify(r)).join("\n") + (list.length ? "\n" : ""));
  const bodies = list.map((r) => stripMentions(r.text));
  const substantive = list.filter((r) => {
    const b = stripMentions(r.text);
    return [...b].length >= 60 && !isLinkOnly(r.text);
  });
  const lens = bodies.map((b) => [...b].length);
  rows.push(
    `${h.padEnd(18)} replies ${String(list.length).padStart(3)}  median ${String(median(lens)).padStart(3)}ch  ` +
      `tiny ${pct(list.filter((r) => isTiny(r.text)).length, list.length).padStart(4)}  ` +
      `link-only ${pct(list.filter((r) => isLinkOnly(r.text)).length, list.length).padStart(4)}  ` +
      `substantive(60ch+) ${pct(substantive.length, list.length).padStart(4)}  ` +
      `dashes ${pct(list.filter((r) => hasDash(r.text)).length, list.length).padStart(4)}  ` +
      `lowercase-start ${pct(bodies.filter((b) => /^[a-z]/.test(b)).length, bodies.length).padStart(4)}  ` +
      `median likes ${median(list.map((r) => r.likes))}`,
  );
}
process.stdout.write(`\n# Reply profile (since ${since}, up to ${max} per account)\n\n${rows.join("\n")}\n`);

// Samples: the most-liked substantive replies, then a few recent ones, so the
// picker sees both the best and the typical.
for (const h of handles) {
  const list = byHandle.get(h.toLowerCase()) ?? [];
  const substantive = list.filter((r) => [...stripMentions(r.text)].length >= 60 && !isLinkOnly(r.text));
  const top = [...substantive].sort((a, b) => b.likes - a.likes).slice(0, 6);
  const seen = new Set(top.map((r) => r.id));
  const recent = substantive.filter((r) => !seen.has(r.id)).slice(0, 4);
  process.stdout.write(`\n## @${h}\n`);
  for (const r of [...top, ...recent]) {
    const to = r.in_reply_to ? ` → @${r.in_reply_to}` : "";
    process.stdout.write(`- (${r.likes} likes${to}) ${stripMentions(r.text).replace(/\s+/g, " ").slice(0, 300)}\n`);
  }
}
process.stdout.write(`\nsaved: ${outDir}/<handle>.jsonl\n`);
