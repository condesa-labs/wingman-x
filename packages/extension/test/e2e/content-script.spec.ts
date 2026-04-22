/**
 * CP04 E2E: content script detects a tweet-detail page, asks the
 * background worker for the daemon port, fetches `/suggestion`, and logs
 * the documented info-level line for 200 responses.
 *
 * Flow:
 *   1. Start a real daemon on a disposable state dir.
 *   2. Seed a candidate with tweet_id="20" via POST /candidates so that
 *      GET /suggestion?tweet_id=20 returns 200.
 *   3. Spin up a tiny HTTP server on localhost:<port> that serves the
 *      fixture at `/jack/status/20`. Serving on localhost (not file://)
 *      is required because MV3 content-script match patterns don't
 *      reliably target file: URLs — the manifest's
 *      `http://localhost/(handle)/status/(id)` entry covers this.
 *   4. Launch Chromium with the unpacked extension, navigate the page to
 *      the fixture URL, and assert that the content script logs
 *      `[twitter-helper] suggestion available for 20` within 5 s.
 *   5. Capture the console log + a screenshot of the page as evidence.
 *
 * We only care about the happy path here — 404 behaviour, UI rendering,
 * and action handlers belong to later checkpoints.
 */
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchWithExtension,
  startDaemon,
  type DaemonHandle,
  type ExtensionCtx,
} from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const fixturePath = resolve(repoRoot, "test/fixtures/tweet-detail.html");
const evidenceDir = resolve(
  repoRoot,
  ".harness/twitter-helper/checkpoints/04/iter-1/evidence",
);

let daemon: DaemonHandle;
let ext: ExtensionCtx;
let fixtureServer: http.Server;
let fixtureBase: string;

/**
 * Start a minimal HTTP server that returns the tweet-detail fixture at
 * `/:handle/status/:id` and 404s anything else. We bind to an ephemeral
 * port (passing 0 to listen) so concurrent harness runs don't collide.
 */
async function startFixtureServer(): Promise<{ base: string; server: http.Server }> {
  const fixtureHtml = readFileSync(fixturePath, "utf8");
  const server = http.createServer((req, res) => {
    const urlPath = req.url ?? "/";
    if (/^\/[^/]+\/status\/\d+\/?(\?.*)?$/.test(urlPath)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixtureHtml);
      return;
    }
    // Return 204 (No Content) for browser-auto-requests like /favicon.ico
    // so Chromium doesn't emit a "Failed to load resource" console error
    // that would fail the E2E's zero-error assertion. A 404 would be
    // equally valid semantically, but 204 keeps the console clean.
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address() as AddressInfo;
  return { base: `http://localhost:${addr.port}`, server };
}

async function seedCandidate(port: number, tweetId: string): Promise<void> {
  const body = {
    candidates: [
      {
        id: `cand-${tweetId}`,
        tweet_id: tweetId,
        tweet_url: `https://twitter.com/jack/status/${tweetId}`,
        author_handle: "@jack",
        tweet_text: "Hello, Twitter.",
        suggested_reply: "Hi Jack, great first tweet.",
        match_reason: "E2E harness seed",
        match_category: "selected",
        kb_refs: [],
      },
    ],
  };
  const res = await fetch(`http://localhost:${port}/candidates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`seed candidate failed: ${res.status} ${await res.text()}`);
  }
}

test.beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  daemon = await startDaemon();
  await seedCandidate(daemon.port, "20");
  const fs = await startFixtureServer();
  fixtureServer = fs.server;
  fixtureBase = fs.base;
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await daemon?.stop();
  await new Promise<void>((resolveClose) => {
    fixtureServer?.close(() => resolveClose());
  });
});

test("content script logs suggestion-available for seeded tweet id", async () => {
  const page = await ext.context.newPage();

  // Collect every console message. We don't pre-filter here because we
  // want to write the full transcript to evidence/console-log.txt.
  const consoleMessages: string[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleMessages.push(line);
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(err.message);
    consoleMessages.push(`[pageerror] ${err.message}`);
  });

  // Navigate to the fixture served at /jack/status/20. This URL matches
  // the content-script's localhost entry in the manifest.
  await page.goto(`${fixtureBase}/jack/status/20`);

  // Wait up to 5 s for the content script to log the expected line.
  // Using page.waitForEvent('console') with a predicate keeps this
  // deterministic — we don't poll in a retry loop.
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg.text().includes("[twitter-helper] suggestion available for 20"),
    timeout: 5_000,
  });

  // Persist evidence for the harness evaluator.
  writeFileSync(
    resolve(evidenceDir, "console-log.txt"),
    consoleMessages.join("\n") + "\n",
    "utf8",
  );
  await page.screenshot({
    path: resolve(evidenceDir, "fixture-loaded.png"),
    fullPage: true,
  });

  // Belt-and-braces: the log line must appear in the captured transcript
  // (Playwright's waitForEvent already asserted this, but having a hard
  // expect() gives a clearer failure message if the flow regresses).
  expect(consoleMessages.join("\n")).toContain(
    "[twitter-helper] suggestion available for 20",
  );

  // Zero error-level console output during the flow. info/log lines
  // from the content script itself are allowed.
  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});
