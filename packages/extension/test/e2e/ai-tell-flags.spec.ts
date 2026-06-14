/**
 * CP03 E2E: ⚠️ AI-tell indicator on flagged candidates.
 *
 * Proves the presentational indicator surfaces on EVERY render site that
 * shows `suggested_reply`, driven end-to-end through the real daemon:
 *
 *   1. Seed TWO candidates via `createDaemonClient.postCandidates` (the
 *      agent-facing contract) — one WITH a non-empty `ai_tell_flags`, one
 *      WITHOUT. This exercises CP01's daemon-side field surviving the
 *      round-trip (POST → store → GET /candidates and GET /suggestion).
 *   2. Popup card surface: open popup.html, assert the flagged card shows
 *      ⚠️ with the matched terms in its `title`, and the unflagged card
 *      shows NO ⚠️.
 *   3. In-page expanded Card surface: navigate to the flagged tweet's
 *      fixture, expand the Dock → Card, assert the Card shows ⚠️ with the
 *      matched terms in its `title`. Then the unflagged tweet's Card shows
 *      NO ⚠️.
 *   4. Screenshots into the CP03 iter-1 evidence dir.
 *   5. Zero console errors throughout.
 *
 * Why a dedicated spec (not folded into full-pipeline)?
 *   - The acceptance criteria require asserting BOTH the present and the
 *     absent case across TWO surfaces; isolating that here keeps each
 *     existing golden-path spec single-purpose.
 *   - Seeding via the agent-kit client mirrors full-pipeline's "agent
 *     simulator" approach so the daemon round-trip is genuine.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemonClient, type CandidateInput } from "@wingman-x/agent-kit";
import {
  launchWithExtension,
  startDaemon,
  type DaemonHandle,
  type ExtensionCtx,
} from "./fixtures.js";
import type { Server } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const EVIDENCE_DIR = resolve(
  repoRoot,
  ".harness/humanizer-ai-tell-flags/checkpoints/03/iter-1/evidence",
);
const fixturePath = resolve(repoRoot, "test/fixtures/tweet-detail.html");

/**
 * Serve the tweet-detail fixture with its `<link rel="canonical">`
 * rewritten to match the requested `/<handle>/status/<id>` path. The
 * content script resolves the tweet_id from the canonical link (not the
 * URL bar), so the shared helper's hardcoded canonical (=20) can't drive
 * the distinct ids (77/78) this spec needs to exercise the flagged vs
 * clean cases on the in-page Card. Rewriting per-request keeps the shared
 * fixture + helper untouched.
 */
async function startCanonicalFixtureServer(): Promise<{
  base: string;
  server: Server;
}> {
  const baseHtml = readFileSync(fixturePath, "utf8");
  const server = http.createServer((req, res) => {
    const urlPath = req.url ?? "/";
    const m = /^\/([^/]+)\/status\/(\d+)\/?(\?.*)?$/.exec(urlPath);
    if (m) {
      const handle = m[1];
      const id = m[2];
      const html = baseHtml.replace(
        /<link rel="canonical" href="[^"]*" \/>/,
        `<link rel="canonical" href="https://twitter.com/${handle}/status/${id}" />`,
      );
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address() as AddressInfo;
  return { base: `http://localhost:${addr.port}`, server };
}

// The matched AI-tell terms the flagged candidate carries. The indicator
// must surface these verbatim in its title/aria-label.
const FLAGS = ["里程碑", "划时代"];
const EXPECTED_TITLE = `AI tell: ${FLAGS.join(", ")}`;

const FLAGGED: CandidateInput = {
  id: "cand-flagged-77",
  tweet_id: "77",
  tweet_url: "https://twitter.com/flagger/status/77",
  author_handle: "@flagger",
  tweet_text: "A flagged tweet for the AI-tell indicator E2E.",
  suggested_reply: "这是一个里程碑式的划时代回复。",
  match_reason: "CP03 flagged seed",
  match_category: "selected",
  kb_refs: [],
  ai_tell_flags: FLAGS,
};

const CLEAN: CandidateInput = {
  id: "cand-clean-78",
  tweet_id: "78",
  tweet_url: "https://twitter.com/cleaner/status/78",
  author_handle: "@cleaner",
  tweet_text: "A clean tweet with no AI-tell flags.",
  suggested_reply: "Sounds good, thanks for sharing.",
  match_reason: "CP03 clean seed",
  match_category: "selected",
  kb_refs: [],
  // intentionally NO ai_tell_flags
};

interface Env {
  daemon: DaemonHandle;
  ext: ExtensionCtx;
  fixture: { base: string; server: Server };
}

let env: Env;

test.beforeAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const daemon = await startDaemon();
  // Seed through the agent-kit client (the agent-facing contract) so the
  // daemon round-trips ai_tell_flags exactly as CP01/CP02 produce it.
  const client = createDaemonClient(daemon.port);
  const { accepted } = await client.postCandidates([FLAGGED, CLEAN]);
  expect(accepted, "daemon should have stored both candidates").toBe(2);
  const fixture = await startCanonicalFixtureServer();
  const ext = await launchWithExtension();
  env = { daemon, ext, fixture };
});

test.afterAll(async () => {
  if (!env) return;
  await env.ext.close().catch(() => {});
  await env.daemon.stop().catch(() => {});
  await new Promise<void>((res) => {
    env.fixture.server.close(() => res());
  });
});

function attachConsole(page: Page): string[] {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  return consoleErrors;
}

test("popup card: ⚠️ on flagged candidate, none on clean candidate", async () => {
  const page = await env.ext.context.newPage();
  const consoleErrors = attachConsole(page);

  await page.goto(`chrome-extension://${env.ext.extensionId}/popup.html`);

  // Both cards should render.
  await expect(page.locator('[data-testid="twh-popup-card"]')).toHaveCount(2, {
    timeout: 5_000,
  });

  const flaggedCard = page.locator(
    `[data-testid="twh-popup-card"][data-id="${FLAGGED.tweet_id}"]`,
  );
  const cleanCard = page.locator(
    `[data-testid="twh-popup-card"][data-id="${CLEAN.tweet_id}"]`,
  );
  await expect(flaggedCard).toBeVisible();
  await expect(cleanCard).toBeVisible();

  // Flagged card: ⚠️ present with the matched terms in its title.
  const flaggedWarn = flaggedCard.locator('[data-testid="twh-popup-ai-tell"]');
  await expect(flaggedWarn).toBeVisible();
  await expect(flaggedWarn).toHaveAttribute("title", EXPECTED_TITLE);
  await expect(flaggedWarn).toHaveAttribute("aria-label", EXPECTED_TITLE);

  // Clean card: NO ⚠️.
  await expect(
    cleanCard.locator('[data-testid="twh-popup-ai-tell"]'),
  ).toHaveCount(0);

  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "popup-ai-tell-indicator.png"),
    fullPage: true,
  });

  expect(
    consoleErrors,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);

  await page.close();
});

test("in-page Card: ⚠️ on flagged candidate, none on clean candidate", async () => {
  // --- Flagged tweet → expand → Card shows ⚠️ ---------------------------
  const page = await env.ext.context.newPage();
  const consoleErrors = attachConsole(page);

  await page.goto(`${env.fixture.base}/flagger/status/${FLAGGED.tweet_id}`);
  await page.waitForEvent("console", {
    predicate: (msg) =>
      msg
        .text()
        .includes(
          `[twitter-helper] suggestion available for ${FLAGGED.tweet_id}`,
        ),
    timeout: 10_000,
  });

  await expect(page.locator("#twh-dock")).toBeVisible({ timeout: 5_000 });
  await page.locator('[data-testid="twh-expand"]').click();
  await expect(page.locator("#twh-card")).toBeVisible({ timeout: 2_000 });
  await expect(
    page.locator('[data-testid="twh-card-reply-preview"]'),
  ).toHaveText(FLAGGED.suggested_reply);

  const cardWarn = page.locator('[data-testid="twh-card-ai-tell"]');
  await expect(cardWarn).toBeVisible();
  await expect(cardWarn).toHaveAttribute("title", EXPECTED_TITLE);
  await expect(cardWarn).toHaveAttribute("aria-label", EXPECTED_TITLE);

  await page.screenshot({
    path: resolve(EVIDENCE_DIR, "card-ai-tell-indicator.png"),
    fullPage: true,
  });
  await page.close();

  // --- Clean tweet → expand → Card shows NO ⚠️ -------------------------
  const cleanPage = await env.ext.context.newPage();
  const cleanErrors = attachConsole(cleanPage);

  await cleanPage.goto(`${env.fixture.base}/cleaner/status/${CLEAN.tweet_id}`);
  await cleanPage.waitForEvent("console", {
    predicate: (msg) =>
      msg
        .text()
        .includes(`[twitter-helper] suggestion available for ${CLEAN.tweet_id}`),
    timeout: 10_000,
  });

  await expect(cleanPage.locator("#twh-dock")).toBeVisible({ timeout: 5_000 });
  await cleanPage.locator('[data-testid="twh-expand"]').click();
  await expect(cleanPage.locator("#twh-card")).toBeVisible({ timeout: 2_000 });
  await expect(
    cleanPage.locator('[data-testid="twh-card-reply-preview"]'),
  ).toHaveText(CLEAN.suggested_reply);
  await expect(
    cleanPage.locator('[data-testid="twh-card-ai-tell"]'),
  ).toHaveCount(0);

  await cleanPage.screenshot({
    path: resolve(EVIDENCE_DIR, "card-no-ai-tell-clean.png"),
    fullPage: true,
  });

  expect(
    [...consoleErrors, ...cleanErrors],
    `unexpected console errors: ${[...consoleErrors, ...cleanErrors].join(
      " | ",
    )}`,
  ).toEqual([]);

  await cleanPage.close();
});
