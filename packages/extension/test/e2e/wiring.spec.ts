import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWithExtension, startDaemon, type DaemonHandle, type ExtensionCtx } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const evidenceDir = resolve(__dirname, "../../../../docs/manual-qa");

test("wiring popup shows candidates seeded from handles and viral_pool sources", async () => {
  mkdirSync(evidenceDir, { recursive: true });
  let daemon: DaemonHandle | undefined;
  let ext: ExtensionCtx | undefined;
  try {
    daemon = await startDaemon();
    const res = await fetch(`http://localhost:${daemon.port}/candidates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidates: [
          candidate("handle-ui", "https://x.com/alice/status/1790000000000000201", "@alice", "handles"),
          candidate("viral-ui", "https://x.com/bob/status/1790000000000000202", "@bob", "viral_pool"),
        ],
      }),
    });
    expect(res.ok).toBe(true);
    ext = await launchWithExtension();
    const page = await ext.context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    await page.goto(`chrome-extension://${ext.extensionId}/popup.html`);
    await expect(page.locator('[data-testid="twh-popup-card"]')).toHaveCount(2);
    expect(consoleErrors).toEqual([]);
    await page.screenshot({
      path: resolve(evidenceDir, "2026-05-09-viral-pool.png"),
      fullPage: true,
    });
  } finally {
    await ext?.close();
    await daemon?.stop();
  }
});

function candidate(
  tweetId: string,
  tweetUrl: string,
  authorHandle: string,
  source: "handles" | "viral_pool",
): Record<string, unknown> {
  return {
    id: `cand-${tweetId}`,
    tweet_id: tweetId,
    tweet_url: tweetUrl,
    author_handle: authorHandle,
    tweet_text: `Wiring ${source} tweet`,
    suggested_reply: `Wiring reply for ${source}`,
    match_reason: "CP07 wiring seed",
    match_category: "topic",
    source,
    kb_refs: ["library/ai.md"],
  };
}
