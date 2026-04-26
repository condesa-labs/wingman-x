#!/usr/bin/env tsx
/**
 * probe-cdp.ts — try connectOverCDP against a list of candidate endpoints,
 * and for each one that attaches, summarize contexts + open pages (URLs
 * only). Useful to discover which running Chrome has an x.com session we
 * can reuse.
 */
import "../../../scripts/load-env.mjs";
import { chromium } from "playwright";

const URLS = (process.env.CDP_URLS ?? "http://localhost:9222,http://localhost:49440,http://localhost:57419")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function probe(url: string): Promise<void> {
  process.stdout.write(`\n=== ${url} ===\n`);
  try {
    const browser = await chromium.connectOverCDP(url, { timeout: 3500 });
    const contexts = browser.contexts();
    process.stdout.write(`  connected. contexts=${contexts.length}\n`);
    for (let i = 0; i < contexts.length; i++) {
      const pages = contexts[i].pages();
      process.stdout.write(`  context[${i}] pages=${pages.length}\n`);
      for (const p of pages) {
        const u = p.url();
        const title = await p.title().catch(() => "");
        process.stdout.write(`    - ${u}   | ${title}\n`);
      }
    }
    await browser.close().catch(() => {});
  } catch (err) {
    process.stdout.write(`  FAILED: ${(err as Error).message.split("\n")[0]}\n`);
  }
}

(async () => {
  for (const u of URLS) await probe(u);
})();
