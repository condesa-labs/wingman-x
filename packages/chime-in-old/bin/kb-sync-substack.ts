#!/usr/bin/env tsx
/**
 * `npm run kb:sync-substack` — pull the publication's RSS feed and save every
 * article as plain-text Markdown under `<kb>/sources/substack/`. This is the
 * KB's memory: full essays, never retrieved directly (Wingman's fs adapter
 * only reads `library/*.md`). New articles are listed so the distilled
 * `library/` files can be updated by hand — extraction stays human-curated.
 *
 *   SUBSTACK_FEED_URL   default https://nomisma.substack.com/feed
 */
import "../../../scripts/load-env.mjs";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWingmanXStateDir } from "../src/paths.js";

const FEED = process.env.SUBSTACK_FEED_URL ?? "https://nomisma.substack.com/feed";
const kbDir = join(resolveWingmanXStateDir(), "kb");
const outDir = join(kbDir, "sources", "substack");
mkdirSync(outDir, { recursive: true });

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8212;/g, ", ")
    .replace(/&#8211;/g, "-")
    .replace(/&#8209;/g, "-")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#9;/g, " ");
}

function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
      .replace(/<h([1-6])[^>]*>/g, (_m, n: string) => `\n${"#".repeat(Math.min(6, Number(n) + 1))} `)
      .replace(/<\/(p|h[1-6]|li|blockquote|div|figure|figcaption)>/g, "\n")
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<li[^>]*>/g, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pick(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`).exec(block);
  return m?.[1]?.trim() ?? "";
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
}

const res = await fetch(FEED);
if (!res.ok) {
  process.stderr.write(`feed fetch failed: HTTP ${res.status}\n`);
  process.exit(1);
}
const xml = await res.text();
const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1] ?? "");
const existing = new Set(readdirSync(outDir));
let created = 0;
const newTitles: string[] = [];
for (const item of items) {
  const title = decode(pick(item, "title"));
  const link = pick(item, "link");
  const pub = pick(item, "pubDate");
  const date = Number.isFinite(Date.parse(pub)) ? new Date(pub).toISOString().slice(0, 10) : "undated";
  const body = htmlToText(pick(item, "content:encoded") || pick(item, "description"));
  const name = `${date}-${slugify(title)}.md`;
  if (existing.has(name) || existsSync(join(outDir, name))) continue;
  const md = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `date: ${date}`,
    `url: ${link}`,
    "source: substack",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
  writeFileSync(join(outDir, name), md, "utf8");
  created += 1;
  newTitles.push(`${date}  ${title}`);
}
process.stdout.write(`${items.length} article(s) in feed, ${created} new saved to ${outDir}\n`);
if (newTitles.length > 0) {
  process.stdout.write("New articles — distil their theses into library/*.md:\n");
  for (const t of newTitles) process.stdout.write(`  - ${t}\n`);
}
