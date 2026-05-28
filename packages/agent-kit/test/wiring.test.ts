import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TSX_BIN = resolve("../../node_modules/.bin/tsx");
const DAEMON_ENTRY = resolve("../daemon/bin/dev.ts");
const WATCHER_ENTRY = resolve("scripts/watcher.ts");

function waitForListenLine(child: ChildProcess, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error(`daemon did not print listen line; output=${buf}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      buf += String(chunk);
      const match = buf.match(/\[daemon\] listening on port (\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolvePromise(Number(match[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`daemon exited ${code}; output=${buf}`));
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000).unref();
  });
}

describe("wiring: watcher script against real daemon", () => {
  let tmpRoot = "";
  let daemon: ChildProcess | undefined;
  let watcher: ChildProcess | undefined;

  afterEach(async () => {
    await stopChild(watcher);
    await stopChild(daemon);
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("drains a real discovery signal, drafts handle and viral-pool candidates, and preserves kb_refs", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "th-wiring-"));
    const stateDir = join(tmpRoot, "state");
    const homeDir = join(tmpRoot, "home");
    const binDir = join(tmpRoot, "bin");
    mkdirSync(join(homeDir, ".twitter-helper", "kb", "library"), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    writeFileSync(join(homeDir, ".twitter-helper", "kb", "tone.md"), "Use concise replies.\n");
    writeFileSync(
      join(homeDir, ".twitter-helper", "kb", "library", "ai.md"),
      "# AI\n\nAgent workflows and AI evaluation notes.\n",
    );
    writeFileSync(
      join(homeDir, ".twitter-helper", "kb", "library", "investing.md"),
      "# Investing\n\nPortfolio and market notes.\n",
    );
    writeFileSync(
      join(homeDir, ".twitter-helper", "kb", "library", "productivity.md"),
      "# Productivity\n\nAutomation and workflow notes.\n",
    );

    const fakeClaude = join(binDir, "claude");
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({",
        "    suggested_reply: 'Wiring smoke reply',",
        "    match_reason: 'matched seeded KB',",
        "    match_category: 'topic',",
        "    kb_refs: ['library/ai.md']",
        "  }));",
        "});",
      ].join("\n"),
    );
    chmodSync(fakeClaude, 0o755);

    const fakeScraper = join(tmpRoot, "scrape.mjs");
    writeFileSync(
      fakeScraper,
      `process.stdout.write(JSON.stringify([{tweet_id:"handle-1",tweet_url:"https://x.com/alice/status/1790000000000000101",author_handle:"@alice",tweet_text:"AI agent workflow from handles"}]));\n`,
    );

    daemon = spawn(TSX_BIN, [DAEMON_ENTRY], {
      cwd: resolve("."),
      env: { ...process.env, WINMAN_X_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await waitForListenLine(daemon);

    const observed = await fetch(`http://localhost:${port}/tweets/observed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tweets: [
          {
            tweet_id: "viral-1",
            tweet_url: "https://x.com/bob/status/1790000000000000102",
            author_handle: "@bob",
            tweet_text: "AI agent workflow from viral pool",
            views: 200_000,
            likes: 10_000,
            retweets: 2_000,
            replies: 500,
            bookmarks: 300,
            created_at: new Date().toISOString(),
          },
        ],
      }),
    });
    expect(observed.ok).toBe(true);

    const signal = await fetch(`http://localhost:${port}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "discovery_requested" }),
    });
    expect(signal.ok).toBe(true);

    watcher = spawn(TSX_BIN, [WATCHER_ENTRY], {
      cwd: resolve("."),
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        WINMAN_X_STATE_DIR: stateDir,
        WATCHER_DRAFT_TIMEOUT_MS: "5000",
        WATCHER_SCRAPE_TIMEOUT_MS: "5000",
        WATCHER_FETCH_TIMEOUT_MS: "5000",
        WATCHER_DAEMON_PORT: String(port),
        WATCHER_SCRAPE_COMMAND: process.execPath,
        WATCHER_SCRAPE_ARGS_JSON: JSON.stringify([fakeScraper]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await expect.poll(async () => {
      const res = await fetch(`http://localhost:${port}/candidates`);
      return ((await res.json()) as { candidates: unknown[] }).candidates.length;
    }, { timeout: 10_000 }).toBe(2);

    const candidates = (await (
      await fetch(`http://localhost:${port}/candidates`)
    ).json()) as { candidates: Array<Record<string, unknown>> };
    expect(candidates.candidates.map((c) => [c.tweet_id, c.source]).sort()).toEqual([
      ["handle-1", "handles"],
      ["viral-1", "viral_pool"],
    ]);
    expect(
      candidates.candidates.some((c) =>
        Array.isArray(c.kb_refs) && c.kb_refs.includes("library/ai.md"),
      ),
    ).toBe(true);

    await expect.poll(async () => {
      const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as {
        signals: Record<string, { status: string }>;
      };
      return Object.values(state.signals).every((s) => s.status === "acked");
    }, { timeout: 5_000 }).toBe(true);
  }, 20_000);
});
