#!/usr/bin/env tsx
/**
 * diag-extension.ts — attach to the dedicated Chrome via CDP, list
 * extensions + service workers, and probe http://localhost:53827/health
 * from both the page context and the extension's background context to
 * pinpoint why the popup shows a disconnected state.
 */
import "../../../scripts/load-env.mjs";
import { chromium, type Browser } from "playwright";

const CDP_URL = process.env.CDP_URL ?? "http://localhost:9223";
const DAEMON_URL = process.env.DAEMON_URL ?? "http://localhost:53827";

function log(s: string) {
  process.stdout.write(s + "\n");
}

(async () => {
  const browser: Browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const contexts = browser.contexts();
    const ctx = contexts[0];

    // 1) Enumerate open pages
    log("=== OPEN PAGES ===");
    for (const p of ctx.pages()) {
      log(`  ${p.url()}`);
    }

    // 2) Enumerate extension service workers (MV3)
    log("\n=== SERVICE WORKERS (MV3 extensions) ===");
    const sws = ctx.serviceWorkers();
    for (const sw of sws) {
      log(`  ${sw.url()}`);
    }
    if (sws.length === 0) {
      log("  (none — no MV3 extension worker is registered in this context)");
    }

    // 3) chrome://extensions page — open and dump extension names/IDs
    log("\n=== chrome://extensions enumeration ===");
    const extPage = await ctx.newPage();
    try {
      await extPage.goto("chrome://extensions/", {
        waitUntil: "domcontentloaded",
        timeout: 8000,
      });
      await extPage.waitForTimeout(800);
      const exts = await extPage.evaluate(() => {
        const mgr = (document as any).querySelector("extensions-manager");
        if (!mgr) return [];
        // Deep-select through shadow roots
        function dive(root: any, out: any[]): any[] {
          if (!root) return out;
          const itemList = root.shadowRoot?.querySelector("extensions-item-list");
          if (itemList) {
            const items = itemList.shadowRoot?.querySelectorAll(
              "extensions-item",
            );
            if (items) {
              for (const it of Array.from(items) as any[]) {
                out.push({
                  id: it.id || it.getAttribute("id") || "",
                  name: it.shadowRoot?.querySelector("#name")?.textContent?.trim() ?? "",
                  enabled:
                    it.shadowRoot?.querySelector("#enableToggle")?.getAttribute(
                      "aria-pressed",
                    ) ??
                    it.shadowRoot?.querySelector("#enableToggle")?.hasAttribute("checked"),
                });
              }
            }
          }
          if (root.shadowRoot) {
            for (const child of Array.from(root.shadowRoot.children) as any[]) {
              dive(child, out);
            }
          }
          return out;
        }
        return dive(mgr, []);
      });
      log(JSON.stringify(exts, null, 2));
    } catch (err) {
      log(`  FAILED to read chrome://extensions: ${(err as Error).message}`);
    } finally {
      await extPage.close();
    }

    // 4) From an x.com tab, try fetching the daemon /health directly
    log("\n=== fetch /health from x.com page context ===");
    const xPage =
      ctx.pages().find((p) => /x\.com|twitter\.com/.test(p.url())) ??
      (await ctx.newPage());
    if (!/x\.com|twitter\.com/.test(xPage.url())) {
      await xPage
        .goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 10000 })
        .catch(() => {});
    }
    try {
      const result = await xPage.evaluate(async (url) => {
        try {
          const res = await fetch(url + "/health");
          const body = await res.text();
          return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
        } catch (err: any) {
          return { err: String(err?.message ?? err) };
        }
      }, DAEMON_URL);
      log(JSON.stringify(result, null, 2));
    } catch (err) {
      log(`  FAILED: ${(err as Error).message}`);
    }

    // 5) If a SW exists for Twitter Helper, probe /health from within it
    log("\n=== fetch /health from extension background (if present) ===");
    const thSw = sws.find((sw) => /twitter[-_ ]?helper|chrome-extension/i.test(sw.url()));
    if (thSw) {
      log(`  using SW at ${thSw.url()}`);
      try {
        const res = await thSw.evaluate(async (url) => {
          try {
            const r = await fetch(url + "/health");
            const body = await r.text();
            return { ok: r.ok, status: r.status, body: body.slice(0, 300) };
          } catch (err: any) {
            return { err: String(err?.message ?? err) };
          }
        }, DAEMON_URL);
        log(JSON.stringify(res, null, 2));
      } catch (err) {
        log(`  SW eval FAILED: ${(err as Error).message}`);
      }
    } else {
      log("  (no extension service worker found — extension may not be loaded)");
    }
  } finally {
    await browser.close().catch(() => {});
  }
})();
