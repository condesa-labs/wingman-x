#!/usr/bin/env tsx
/**
 * scrape-following.ts — detect the logged-in X handle via the session's
 * sidebar, then walk the /following page with bounded infinite scroll
 * and emit the complete follow list as a JSON array of @handles to
 * stdout.
 *
 * Env:
 *   CDP_URL       — default http://localhost:9223
 *   MAX_SCROLLS   — bounded scroll iterations, default 80
 *   SCROLL_WAIT   — ms between scrolls, default 700
 */
import { chromium, type Page } from "playwright";

const CDP_URL = process.env.CDP_URL ?? "http://localhost:9223";
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS ?? "80");
const SCROLL_WAIT = Number(process.env.SCROLL_WAIT ?? "700");

function log(s: string) {
  process.stderr.write(`[following] ${s}\n`);
}

async function detectUserHandle(page: Page): Promise<string | null> {
  // Try sidebar profile link first — stable testid across recent x.com
  // revisions. Fallback: any sidebar link that matches /^\/[^/]+$/ with
  // aria-label containing "Profile".
  const profileHref = await page.evaluate(() => {
    const link =
      document.querySelector<HTMLAnchorElement>(
        'a[data-testid="AppTabBar_Profile_Link"]',
      ) ??
      document.querySelector<HTMLAnchorElement>(
        'nav[role="navigation"] a[aria-label*="Profile" i]',
      );
    return link?.getAttribute("href") ?? null;
  });
  if (profileHref === null) return null;
  const m = profileHref.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
  return m ? m[1] : null;
}

async function scrollAndCollect(page: Page): Promise<string[]> {
  const seen = new Set<string>();
  let stagnant = 0;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    const batch = await page.evaluate(() => {
      // Each "UserCell" row on /following contains an anchor to the
      // user's profile. We harvest all such anchors and let the
      // outer loop dedupe.
      const cells = Array.from(
        document.querySelectorAll('[data-testid="UserCell"]'),
      );
      const handles = new Set<string>();
      for (const cell of cells) {
        // The second-line (@handle) link — not the display-name link.
        // Twitter repeats the profile href multiple times; any one is
        // fine since they all point to the same handle.
        const links = Array.from(
          cell.querySelectorAll<HTMLAnchorElement>('a[role="link"]'),
        );
        for (const link of links) {
          const href = link.getAttribute("href") ?? "";
          const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
          if (m) {
            handles.add(m[1]);
            break;
          }
        }
      }
      return Array.from(handles);
    });

    const before = seen.size;
    for (const h of batch) seen.add(h);
    log(`scroll ${i + 1}/${MAX_SCROLLS}: added ${seen.size - before}, total ${seen.size}`);

    if (seen.size === before) {
      stagnant++;
      if (stagnant >= 3) {
        log("3 stagnant scrolls — end of list reached");
        break;
      }
    } else {
      stagnant = 0;
    }

    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(SCROLL_WAIT);
  }

  return Array.from(seen);
}

(async () => {
  log(`attaching to ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();

    // Start on /home so the sidebar renders deterministically
    await page.goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForTimeout(1500);

    const handle = await detectUserHandle(page);
    if (handle === null) {
      log("ERROR: could not detect logged-in handle from sidebar");
      process.exit(2);
    }
    log(`detected user handle: @${handle}`);

    const followingUrl = `https://x.com/${handle}/following`;
    log(`navigating ${followingUrl}`);
    await page.goto(followingUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    try {
      await page.waitForSelector('[data-testid="UserCell"]', {
        timeout: 10000,
      });
    } catch {
      log("no UserCell rendered — list may be empty or restricted");
    }
    await page.waitForTimeout(1000);

    const handles = await scrollAndCollect(page);
    await page.close();

    log(`final count: ${handles.length}`);
    const output = {
      user: `@${handle}`,
      scraped_at: new Date().toISOString(),
      following: handles.map((h) => `@${h}`).sort((a, b) => a.localeCompare(b)),
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } finally {
    await browser.close().catch(() => {});
  }
})();
