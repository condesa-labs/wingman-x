#!/usr/bin/env tsx
import "../../../scripts/load-env.mjs";
import { chromium } from "playwright";

const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9223";
const DAEMON_URL = process.env.DAEMON_URL ?? "http://localhost:53827";
const EXT_ID = process.env.EXT_ID ?? "jlbbggcnjfnckpfommnbonnobhoeapdh";

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    const popupUrl = `chrome-extension://${EXT_ID}/popup.html`;
    const page = await ctx.newPage();
    const logs: { type: string; text: string }[] = [];
    page.on("console", (msg) => logs.push({ type: msg.type(), text: msg.text() }));
    page.on("pageerror", (err) => logs.push({ type: "pageerror", text: err.message }));

    console.log(`opening ${popupUrl}`);
    await page.goto(popupUrl, { waitUntil: "domcontentloaded", timeout: 8000 });
    // Let popup.ts scripts run
    await page.waitForTimeout(1500);

    console.log("--- popup body text ---");
    console.log(await page.evaluate(() => document.body.innerText));

    // fetch /health from popup origin
    const fetchProbe = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url + "/health");
        return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 200) };
      } catch (err: any) {
        return { err: String(err?.message ?? err) };
      }
    }, DAEMON_URL);
    console.log("--- fetch /health from popup origin ---");
    console.log(JSON.stringify(fetchProbe, null, 2));

    // chrome.storage.session.daemon_port
    const storageProbe = await page.evaluate(async () => {
      try {
        // @ts-ignore
        const entry = await chrome.storage.session.get("daemon_port");
        return { ok: true, entry };
      } catch (err: any) {
        return { err: String(err?.message ?? err) };
      }
    });
    console.log("--- chrome.storage.session.daemon_port ---");
    console.log(JSON.stringify(storageProbe, null, 2));

    // Full port range scan
    const scan = await page.evaluate(async () => {
      const ports = [53827, 53828, 53829, 53830, 53831, 53832, 53833, 53834, 53835, 53836];
      const out: any[] = [];
      for (const p of ports) {
        try {
          const res = await fetch(`http://localhost:${p}/health`);
          const body = res.ok ? await res.json().catch(() => null) : null;
          out.push({ port: p, status: res.status, body });
        } catch (err: any) {
          out.push({ port: p, err: String(err?.message ?? err) });
        }
      }
      return out;
    });
    console.log("--- full port-range scan ---");
    console.log(JSON.stringify(scan, null, 2));

    if (logs.length > 0) {
      console.log("--- popup console events ---");
      logs.forEach((l) => console.log(`[${l.type}] ${l.text}`));
    }

    await page.close();
  } finally {
    await browser.close().catch(() => {});
  }
})();
