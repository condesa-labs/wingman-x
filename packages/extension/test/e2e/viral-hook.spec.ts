import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const fixturePath = resolve(repoRoot, "packages/extension/test/fixtures/graphql-response.html");
const hookPath = resolve(repoRoot, "packages/extension/dist/viral-hook.js");
const evidenceDir = resolve(
  repoRoot,
  ".harness/twitter-helper-viral-pool/checkpoints/03/iter-1/evidence",
);

test("viral hook emits TH_VIRAL_OBSERVED for GraphQL fetch responses", async ({ page }) => {
  mkdirSync(evidenceDir, { recursive: true });
  const server = await startFixtureServer();
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  try {
    await page.goto(`${server.base}/fixture`);
    await page.getByRole("button").click();
    await page.waitForTimeout(250);
    await expect.poll(() => page.evaluate(() => window.__viralMessages.length)).toBe(0);
    await page.screenshot({ path: resolve(evidenceDir, "viral-hook-before.png"), fullPage: true });

    await page.addScriptTag({ path: hookPath });
    await page.getByRole("button").click();
    await expect.poll(() => page.evaluate(() => window.__viralMessages.length)).toBe(1);
    expect(await page.evaluate(() => window.__viralMessages[0])).toMatchObject({
      type: "TH_VIRAL_OBSERVED",
      tweets: [{ tweet_id: "1790000000000000999", author_handle: "alice_ai", views: 123456 }],
    });
    await page.screenshot({ path: resolve(evidenceDir, "viral-hook-after.png"), fullPage: true });
    expect(consoleErrors).toEqual([]);
  } finally {
    await server.close();
  }
});

async function startFixtureServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const html = readFileSync(fixturePath, "utf8");
  const server = http.createServer((req, res) => {
    if (req.url === "/fixture") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } else if (req.url === "/i/api/graphql/HomeTimeline") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(graphqlFixture()));
    } else {
      res.writeHead(204).end();
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://localhost:${addr.port}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

function graphqlFixture(): unknown {
  return { data: { x: { tweet_results: { result: {
    __typename: "Tweet",
    rest_id: "1790000000000000999",
    legacy: { full_text: "A fast-moving AI workflow note.", created_at: "Sat May 09 11:30:00 +0000 2026", favorite_count: 1000, retweet_count: 300, reply_count: 80, bookmark_count: 120 },
    views: { count: "123456" },
    core: { user_results: { result: { legacy: { screen_name: "alice_ai" } } } },
  } } } } };
}

declare global {
  interface Window {
    __viralMessages: Array<{ type: string; tweets: Array<Record<string, unknown>> }>;
  }
}
