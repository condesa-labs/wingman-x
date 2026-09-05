#!/usr/bin/env tsx
/**
 * `npm run apify:probe -- --handles a,b --max 20 [--mode search|handles]`
 * Runs the configured actor once for a few handles, writes the RAW
 * dataset to `<chimeDir>/scans/apify-probe-<ts>.json`, and prints how
 * many items normalised cleanly. Use it once to sanity-check an actor
 * (and its cost) before a full scan; the dump also works as `--fixture`.
 */
import "../../../scripts/load-env.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { chimePaths } from "../src/paths.js";
import { createApifyClientRunner } from "../src/sources/apify/apify-client-runner.js";
import { buildHandlesInput, buildSearchInput, inferInputStyle } from "../src/sources/apify/apify-source.js";
import { normalizeApifyItems } from "../src/sources/apify/normalize.js";

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

const config = loadConfig();
if (!config.apifyToken) {
  process.stderr.write("APIFY_TOKEN is not set\n");
  process.exit(1);
}
const handles = (flag("--handles") ?? "").split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
if (handles.length === 0) {
  process.stderr.write("usage: npm run apify:probe -- --handles a,b [--max 20] [--mode search|handles] [--hours 48]\n");
  process.exit(1);
}
const max = Number(flag("--max") ?? "10");
const mode = (flag("--mode") ?? config.apifyMode) as "search" | "handles";
const hours = Number(flag("--hours") ?? String(config.lookbackHours));
const since = new Date(Date.now() - hours * 3600 * 1000);
const opts = { maxPostsPerAccount: max, includeReplies: config.includeReplies, includeReposts: config.includeReposts };
const style = inferInputStyle(config.apifyActor);
const input =
  mode === "search" || style === "zebu"
    ? buildSearchInput(handles, since, opts, config.apifyHandlesPerQuery, style)
    : buildHandlesInput(handles, opts);

process.stdout.write(`actor ${config.apifyActor} (${mode})\ninput ${JSON.stringify(input)}\n`);
const run = createApifyClientRunner({
  token: config.apifyToken,
  actorId: config.apifyActor,
  timeoutSecs: config.apifyTimeoutSecs,
  log: (l) => process.stdout.write(`${l}\n`),
});
const items = await run(input);
const paths = chimePaths(config.chimeDir);
mkdirSync(paths.scansDir, { recursive: true });
const out = join(paths.scansDir, `apify-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(items, null, 2));
const posts = normalizeApifyItems(items, new Date().toISOString());
process.stdout.write(`${items.length} raw item(s) → ${posts.length} normalised post(s)\nraw dump: ${out}\n`);
for (const p of posts.slice(0, 5)) {
  process.stdout.write(`- @${p.author_handle} ${p.created_at} reply=${p.is_reply} repost=${p.is_repost} :: ${p.tweet_text.slice(0, 80).replace(/\n/g, " ")}\n`);
}
