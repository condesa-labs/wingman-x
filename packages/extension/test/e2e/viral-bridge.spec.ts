import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWithExtension } from "./fixtures.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceDir = resolve(repoRoot, ".harness/twitter-helper-viral-pool/checkpoints/04/iter-1/evidence");

test("viral bridge batches TH_VIRAL_OBSERVED messages into daemon POST", async () => {
  mkdirSync(evidenceDir, { recursive: true });
  const received: Array<{ url: string; headers: http.IncomingHttpHeaders; body: { tweets: unknown[] } }> = [];
  const requests: string[] = [];
  let observedAttempts = 0;
  const state: { tweet_pool: Record<string, unknown> } = { tweet_pool: {} };
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    // The content script POSTs cross-origin: the page is served from
    // http://localhost:<port> but the daemon host is 127.0.0.1 (since the
    // IPv6 fix in ed83342 pinned DAEMON_HOST to the numeric loopback). So
    // the browser fires a CORS preflight and only reads responses that
    // carry ACAO + the exposed daemon header. Mirror the real daemon's
    // @fastify/cors config (packages/daemon/src/server.ts) so this mock
    // exercises the same path production does — otherwise the preflight is
    // rejected and the POST never leaves the browser.
    const cors: http.OutgoingHttpHeaders = {
      "access-control-allow-origin": req.headers.origin ?? "*",
      "access-control-expose-headers": "x-twitter-helper-daemon",
    };
    if (req.method === "OPTIONS") {
      res
        .writeHead(204, {
          ...cors,
          "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
          "access-control-allow-headers": "content-type",
        })
        .end();
      return;
    }
    if (req.url === "/health") {
      return json(res, { status: "ok", version: "test" }, cors);
    }
    if (/^\/alice\/status\/\d+/.test(req.url ?? "")) return html(res);
    if (req.url === "/tweets/observed" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        observedAttempts += 1;
        if (observedAttempts === 1) {
          res.writeHead(503, { "x-twitter-helper-daemon": "test", ...cors }).end();
          return;
        }
        const body = JSON.parse(raw) as { tweets: Array<{ tweet_id: string }> };
        for (const tweet of body.tweets) state.tweet_pool[tweet.tweet_id] = tweet;
        received.push({ url: req.url ?? "", headers: req.headers, body });
        json(res, { stored: 3 }, cors);
      });
      return;
    }
    // Catch-all (e.g. the content script's cross-origin GET /suggestion):
    // stamp CORS like the real daemon does on every response, else the
    // browser blocks the read and logs a CORS error that trips the
    // zero-console-errors assertion.
    res.writeHead(204, cors).end();
  });
  await new Promise<void>((resolveListen) => server.listen(53827, "127.0.0.1", resolveListen));
  const ext = await launchWithExtension();
  const page = await ext.context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  try {
    await page.goto("http://localhost:53827/alice/status/1790000000000000001");
    await page.setContent(`<pre>${JSON.stringify(state, null, 2)}</pre>`);
    writeFileSync(resolve(evidenceDir, "tweet-pool-before.json"), JSON.stringify(state, null, 2));
    await page.screenshot({ path: resolve(evidenceDir, "viral-bridge-before.png"), fullPage: true });
    await page.goto("http://localhost:53827/alice/status/1790000000000000001");
    await page.evaluate(() => {
      const tweet = { tweet_id: "1790000000000000001", tweet_url: "https://x.com/alice/status/1790000000000000001", author_handle: "alice", tweet_text: "Fast timeline item.", views: 1000, likes: 10, retweets: 2, replies: 1, bookmarks: 1, created_at: "2026-05-09T12:00:00.000Z" };
      window.postMessage({ type: "TH_VIRAL_OBSERVED", tweets: [{ tweet_id: "malformed" }] }, window.location.origin);
      for (let i = 0; i < 3; i++) window.postMessage({ type: "TH_VIRAL_OBSERVED", tweets: [{ ...tweet, tweet_id: `${tweet.tweet_id}${i}` }] }, window.location.origin);
    });
    await expect.poll(() => received.length, { timeout: 8000 }).toBe(1);
    expect(received[0]!.url).toBe("/tweets/observed");
    expect(received[0]!.headers["x-twitter-helper-daemon"]).toBeUndefined();
    expect(received[0]!.headers["content-type"]).toContain("application/json");
    expect(received[0]!.body.tweets).toHaveLength(3);
    expect(requests.filter((request) => request === "POST /tweets/observed")).toHaveLength(2);
    writeFileSync(resolve(evidenceDir, "tweet-pool-after.json"), JSON.stringify(state, null, 2));
    await page.setContent(`<pre>${JSON.stringify(state, null, 2)}</pre>`);
    await page.screenshot({ path: resolve(evidenceDir, "viral-bridge-after.png"), fullPage: true });
    expect(consoleErrors.filter((message) => !message.includes("status of 503"))).toEqual([]);
  } finally {
    writeFileSync(resolve(evidenceDir, "viral-bridge-requests.txt"), requests.join("\n") + "\n");
    await page.close().catch(() => {});
    await ext.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

function json(
  res: http.ServerResponse,
  body: unknown,
  extraHeaders: http.OutgoingHttpHeaders = {},
): void {
  res.writeHead(200, {
    "x-twitter-helper-daemon": "test",
    "content-type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function html(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>bridge fixture</title><main>bridge fixture</main>");
}
