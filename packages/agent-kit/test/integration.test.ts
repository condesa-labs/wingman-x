import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemonClient, CandidateSchema } from "../src/index.js";

/**
 * Integration test: spin up a REAL daemon, round-trip candidates through
 * `createDaemonClient()`, and assert the end-to-end shape.
 *
 * Design choices:
 *   - We launch the daemon the same way `npm --workspace @twitter-helper/daemon run dev`
 *     does: `tsx bin/dev.ts`. That IS the CP01 launcher. We deliberately
 *     avoid spawning `dist/bin/dev.js` because the daemon's `tsc` build
 *     doesn't copy `package.json` into `dist/` (a latent CP01 wart —
 *     out of scope to fix here). The runtime behaviour is identical.
 *   - We parse the chosen port from the grep-able line
 *     `[daemon] listening on port <N>` printed via `console.info()` by
 *     `packages/daemon/src/port.ts`. CP02 enforces this is stable.
 *   - Each test gets an isolated state directory via
 *     `TWITTER_HELPER_STATE_DIR`, so this test never touches
 *     `~/.twitter-helper/state.json`.
 *   - The daemon's port range is 53827..53836 — "random port" in the
 *     spec maps to "whatever port in that range is free", which is what
 *     the daemon auto-picks. The client uses whichever port was
 *     reported on stdout.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * We launch the daemon exactly the way `npm --workspace @twitter-helper/daemon run dev`
 * does: via `tsx` on `bin/dev.ts`. That's the CP01-produced launcher, and
 * it uses the CP02-persistent Fastify server. We intentionally do NOT go
 * through the emitted `dist/bin/dev.js` because the daemon's build step
 * does not copy `package.json` into `dist/` (a latent CP01 wart — out of
 * scope for this checkpoint and explicitly outside our scope constraint).
 */
const DAEMON_ENTRY = resolve(__dirname, "../../daemon/bin/dev.ts");
const TSX_BIN = resolve(
  __dirname,
  "../../../node_modules/.bin/tsx",
);

function waitForListenLine(child: ChildProcess, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error(`daemon did not print listen line within ${timeoutMs}ms; stdout so far: ${buf}`));
    }, timeoutMs);

    const onData = (chunk: Buffer | string): void => {
      buf += String(chunk);
      const match = buf.match(/\[daemon\] listening on port (\d+)/);
      if (match) {
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
      rejectPromise(new Error(`daemon exited with code ${code} before listen line; buf: ${buf}`));
    });
  });
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise();
    child.once("exit", () => resolvePromise());
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
  });
}

describe("integration: agent-kit against real daemon", () => {
  let tmpDir: string;
  let child: ChildProcess;
  let port: number;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-kit-int-"));
    child = spawn(TSX_BIN, [DAEMON_ENTRY], {
      env: {
        ...process.env,
        TWITTER_HELPER_STATE_DIR: tmpDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    port = await waitForListenLine(child);
    // Announce for the evidence capture script.
    // eslint-disable-next-line no-console
    console.info(`[integration-test] daemon PID=${child.pid} bound port=${port} stateDir=${tmpDir}`);
  }, 20_000);

  afterAll(async () => {
    if (child) await killChild(child);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips POST /candidates → GET /candidates with correct shape", async () => {
    const client = createDaemonClient(port);

    const inputs = [
      {
        id: "uuid-int-1",
        tweet_id: "int-tweet-1",
        tweet_url: "https://x.com/alice_ai/status/int-tweet-1",
        author_handle: "@alice_ai",
        tweet_text: "integration test tweet",
        suggested_reply: "integration test reply 1",
        match_reason: "test",
        match_category: "topic" as const,
        kb_refs: ["library/sample.md"],
      },
      {
        id: "uuid-int-2",
        tweet_id: "int-tweet-2",
        tweet_url: "https://x.com/bob_io/status/int-tweet-2",
        author_handle: "@bob_io",
        tweet_text: "another integration test tweet",
        suggested_reply: "integration test reply 2",
        match_reason: "test",
        match_category: "selected" as const,
        kb_refs: [],
      },
    ];

    const postResult = await client.postCandidates(inputs);
    expect(postResult.accepted).toBe(2);

    const list = await client.getCandidates();
    expect(list).toHaveLength(2);

    // The daemon-returned shape must pass the canonical zod schema —
    // this is the critical "assert shape match" step. If the daemon's
    // schema drifts from agent-kit's, this will fail loudly.
    for (const c of list) {
      expect(() => CandidateSchema.parse(c)).not.toThrow();
    }

    const byId = new Map(list.map((c) => [c.tweet_id, c]));
    expect(byId.get("int-tweet-1")?.suggested_reply).toBe("integration test reply 1");
    expect(byId.get("int-tweet-2")?.match_category).toBe("selected");
    // Server-managed fields must be present and look ISO-8601-ish.
    for (const c of list) {
      expect(c.status).toBe("pending");
      expect(c.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(c.status_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("postAction updates the status and a subsequent GET reflects it", async () => {
    const client = createDaemonClient(port);

    // The daemon keys candidates by `tweet_id` (see packages/daemon/
    // src/server.ts — `state.candidates[input.tweet_id]`), so the
    // action endpoint expects the tweet_id as its path segment.
    await client.postAction("int-tweet-1", "filled");

    const list = await client.getCandidates();
    const updated = list.find((c) => c.tweet_id === "int-tweet-1");
    expect(updated?.status).toBe("filled");
  });

  it("getConfig returns kb_dir from the running daemon", async () => {
    const client = createDaemonClient(port);
    const cfg = await client.getConfig();
    // Daemon's in-memory `state.port` is set only when `buildServer()`
    // is called with `{port}` — which the production CLI does not do.
    // It reports an empty port here; we still verify the other field
    // the daemon does populate (kb_dir). A port-drift check lives in
    // the daemon's own CP02 tests, not here.
    expect(typeof cfg.kb_dir).toBe("string");
    expect(cfg.kb_dir.length).toBeGreaterThan(0);
  });
});
