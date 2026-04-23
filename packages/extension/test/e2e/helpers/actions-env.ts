/**
 * CP06 E2E helpers — shared setup across the action-handler specs.
 *
 * Each spec file in this checkpoint drives the same environment:
 *   - spawn the real daemon on a disposable state dir
 *   - seed a single candidate with tweet_id="20" so /suggestion resolves
 *   - serve the fixture over HTTP so the content-script matches the
 *     manifest's `http://localhost/*(\/status\/*)` pattern
 *   - launch Chromium with the unpacked extension
 *
 * The helper returns a POJO of handles + a single `teardown()` so
 * individual specs do not repeat ~80 lines of boilerplate. This is the
 * "factor into a test/e2e/helpers/ module" hint from the CP06 guidance.
 */
import { mkdirSync, readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchWithExtension,
  startDaemon,
  type DaemonHandle,
  type ExtensionCtx,
} from "../fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../..");
const fixturePath = resolve(repoRoot, "test/fixtures/tweet-detail.html");

export const EVIDENCE_DIR = resolve(
  repoRoot,
  ".harness/twitter-helper/checkpoints/06/iter-1/evidence",
);

export interface CP06Env {
  daemon: DaemonHandle;
  ext: ExtensionCtx;
  fixtureServer: http.Server;
  fixtureBase: string;
  teardown: () => Promise<void>;
}

export interface SeedCandidateOptions {
  /** Defaults to "20" to match the seed used across CP04/CP05. */
  tweetId?: string;
  /** Defaults to a stable string so assertions on text are deterministic. */
  suggestedReply?: string;
}

export async function seedCandidate(
  port: number,
  options: SeedCandidateOptions = {},
): Promise<void> {
  const tweetId = options.tweetId ?? "20";
  const suggestedReply =
    options.suggestedReply ?? "Hi Jack, great first tweet.";
  const body = {
    candidates: [
      {
        id: `cand-${tweetId}`,
        tweet_id: tweetId,
        tweet_url: `https://twitter.com/jack/status/${tweetId}`,
        author_handle: "@jack",
        tweet_text: "Hello, Twitter.",
        suggested_reply: suggestedReply,
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

/**
 * Start a small HTTP server serving the tweet-detail fixture at
 * `/:handle/status/:id`. Returns a 204 (No Content) for favicon etc. so
 * the console stays clean — the E2E's zero-error assertion would
 * otherwise fail on "Failed to load resource: favicon".
 *
 * Exported so the CP10 full-pipeline spec can reuse the same fixture
 * server without re-implementing 15 lines of node:http boilerplate. The
 * CP10 env is orchestrated inline in the spec (agent-kit client for
 * seed, no CP06-specific defaults) so sharing this small primitive
 * keeps the fixture-serving logic in exactly one place.
 */
export async function startFixtureServer(): Promise<{
  base: string;
  server: http.Server;
}> {
  const fixtureHtml = readFileSync(fixturePath, "utf8");
  const server = http.createServer((req, res) => {
    const urlPath = req.url ?? "/";
    if (/^\/[^/]+\/status\/\d+\/?(\?.*)?$/.test(urlPath)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixtureHtml);
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

/**
 * Bring up the full CP06 test environment. Always ensures
 * `evidence/` exists so specs can drop screenshots straight in.
 */
export async function startCP06Env(
  seed: SeedCandidateOptions = {},
): Promise<CP06Env> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const daemon = await startDaemon();
  await seedCandidate(daemon.port, seed);
  const { base, server } = await startFixtureServer();
  const ext = await launchWithExtension();

  const teardown = async (): Promise<void> => {
    await ext.close().catch(() => {});
    await daemon.stop().catch(() => {});
    await new Promise<void>((res) => {
      server.close(() => res());
    });
  };

  return {
    daemon,
    ext,
    fixtureServer: server,
    fixtureBase: base,
    teardown,
  };
}
