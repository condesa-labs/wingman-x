#!/usr/bin/env tsx
/**
 * watcher.ts — long-running SSE subscriber that drives the discovery
 * loop end-to-end. Run as `npm --workspace @twitter-helper/agent-kit
 * run watcher` per CP05 of the twitter-helper-watcher spec.
 *
 * Architecture (concise):
 *   1. KB load (once, on startup): read ~/.twitter-helper/kb/tone.md
 *      and ~/.twitter-helper/kb/library/*.md and concat them into the
 *      system-prompt body. The safety-boundary phrasing comes from
 *      `watcher-core.ts#SAFETY_BOUNDARY_PROMPT`.
 *   2. Probe daemon ports 53827..53836 for a live /health response.
 *   3. Print the startup banner, register the SIGINT cleanup handler.
 *   4. If --dry-run was passed, run the dry-run banner and exit.
 *   5. Otherwise loop: open a streaming fetch on `/events`, drive
 *      `parseSseFrame` over each chunk, hand `signal_added` payloads to
 *      `dispatchSignal` → `runDiscovery`. On transport error, sleep
 *      using `RECONNECT_BACKOFF_MS[attempt]` (capped at 30s) and retry.
 *
 * Why is the testable logic factored into `src/watcher-core.ts`?
 *   Vitest's coverage scope is `src/**` — keeping I/O wiring out of
 *   `src/` lets coverage stay honest on the unit-tested core. The
 *   parts that DO live here (KB read, port probe, SSE loop) are
 *   exercised end-to-end via the `--dry-run` test path and the manual
 *   CP06 verification step.
 */
import "../../../scripts/load-env.mjs";
import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RECONNECT_BACKOFF_MS,
  SAFETY_BOUNDARY_PROMPT,
  dispatchSignal,
  runDiscovery,
  runDryRun,
  type WatcherConfig,
  type WatcherCounters,
} from "../src/watcher-core.js";
import { parseSseFrame } from "../src/sse-parser.js";

const KB_DIR = join(homedir(), ".twitter-helper", "kb");
const PORT_START = 53827;
const PORT_END = 53836;
const DEFAULT_DRAFT_TIMEOUT_MS = 60_000;
const SUMMARY_EVERY_N = 5;

interface KbLoadResult {
  systemPrompt: string;
  toneBytes: number;
  libraryFiles: number;
}

function loadKb(): KbLoadResult {
  let tone = "";
  const tonePath = join(KB_DIR, "tone.md");
  if (existsSync(tonePath)) {
    tone = readFileSync(tonePath, "utf-8");
  }

  const libraryDir = join(KB_DIR, "library");
  const libraryDocs: string[] = [];
  let libraryCount = 0;
  if (existsSync(libraryDir) && statSync(libraryDir).isDirectory()) {
    for (const entry of readdirSync(libraryDir)) {
      if (!entry.endsWith(".md")) continue;
      libraryDocs.push(readFileSync(join(libraryDir, entry), "utf-8"));
      libraryCount += 1;
    }
  }

  const systemPrompt = [
    "# Tone",
    tone,
    "# Library",
    libraryDocs.join("\n\n---\n\n"),
    SAFETY_BOUNDARY_PROMPT,
  ].join("\n\n");

  return {
    systemPrompt,
    toneBytes: Buffer.byteLength(tone, "utf-8"),
    libraryFiles: libraryCount,
  };
}

function findClaudeBin(): string {
  // Resolve via `which claude` so the dry-run banner shows the actual
  // path. If the `which` lookup fails, fall back to the literal "claude"
  // string and let the OS PATH resolve it at spawn time.
  const result = spawnSync("which", ["claude"], { encoding: "utf-8" });
  if (result.status === 0 && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }
  return "claude";
}

async function probeDaemonPort(): Promise<number | null> {
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 500);
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) return port;
    } catch {
      // try the next port
    }
  }
  return null;
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes("--dry-run");

  const kb = loadKb();
  const claudeBin = findClaudeBin();

  // For dry-run we don't probe, so we use the canonical primary port for
  // the banner. CP06 manual verify explicitly states 53827.
  const port = isDryRun ? PORT_START : (await probeDaemonPort()) ?? PORT_START;

  const draftTimeoutMs = Number(
    process.env.WATCHER_DRAFT_TIMEOUT_MS ?? DEFAULT_DRAFT_TIMEOUT_MS,
  );

  const config: WatcherConfig = {
    daemonPort: port,
    draftTimeoutMs,
    kbSystemPrompt: kb.systemPrompt,
    scrapeCommand: process.execPath, // node — invoke tsx via node loader path below
    scrapeArgs: [
      // Use the local tsx binary to drive the scraper. Resolve relative
      // to the repo's node_modules so the watcher works regardless of
      // CWD.
      // eslint-disable-next-line no-undef
      new URL("../../../node_modules/.bin/tsx", import.meta.url).pathname,
      // eslint-disable-next-line no-undef
      new URL("./scrape-x-handles.ts", import.meta.url).pathname,
    ],
    claudeBin,
    summaryEveryN: SUMMARY_EVERY_N,
    toneBytes: kb.toneBytes,
    libraryFiles: kb.libraryFiles,
  };

  // Replace `scrapeCommand` with tsx directly — simpler than node + tsx args.
  config.scrapeCommand = config.scrapeArgs.shift()!;

  // Banner first so it's visible even if dry-run exits immediately.
  process.stdout.write(
    `watcher pid=${process.pid} — to stop: kill ${process.pid}\n`,
  );

  if (isDryRun) {
    const code = await runDryRun(config, (s) =>
      process.stdout.write(`${s}\n`),
    );
    process.exit(code);
  }

  // Track in-flight children so SIGINT can SIGTERM them all.
  const inflightChildren = new Set<ChildProcess>();
  const trackChild = (child: ChildProcess): (() => void) => {
    inflightChildren.add(child);
    return () => inflightChildren.delete(child);
  };

  process.on("SIGINT", () => {
    process.stdout.write(
      `\nwatcher: SIGINT received — terminating ${inflightChildren.size} child(ren)\n`,
    );
    for (const c of inflightChildren) {
      try {
        c.kill("SIGTERM");
      } catch {
        // already dead
      }
    }
    process.exit(0);
  });

  const counters: WatcherCounters = {
    drafts_attempted: 0,
    drafted_ok: 0,
    drafted_failed_timeout: 0,
    drafted_failed_invalid_json: 0,
    drafted_failed_exit: 0,
    drafted_failed_empty: 0,
  };

  const log = (l: string): void => {
    // process.stdout.write returns boolean; void return type discards it.
    process.stdout.write(`${l}\n`);
  };

  let attempt = 0;
  while (true) {
    try {
      log(
        JSON.stringify({
          event: "subscribed",
          message: `subscribed to /events on port ${config.daemonPort}`,
        }),
      );
      const res = await fetch(`http://localhost:${config.daemonPort}/events`);
      if (!res.ok || res.body === null) {
        throw new Error(`/events returned ${res.status}`);
      }
      attempt = 0; // successful connect — reset backoff

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const out = parseSseFrame(buffer);
        buffer = out.remainder;
        for (const frame of out.frames) {
          await dispatchSignal(frame.data, async (signal) => {
            log(
              JSON.stringify({
                event: "signal_received",
                id: signal.id,
                kind: signal.kind,
              }),
            );
            await runDiscovery(signal, {
              config,
              counters,
              log,
              trackChild,
            });
          });
        }
      }
    } catch (err) {
      log(
        JSON.stringify({
          event: "stream_error",
          message: (err as Error).message ?? String(err),
        }),
      );
    }
    // Reconnect with exponential backoff per RECONNECT_BACKOFF_MS.
    const delay =
      RECONNECT_BACKOFF_MS[
        Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)
      ] ?? 30_000;
    log(JSON.stringify({ event: "reconnect_scheduled", delay_ms: delay }));
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempt += 1;
  }
}

main().catch((err) => {
  // Top-level guard. The reconnect loop swallows transport errors
  // internally, but a programmer-error throw outside the loop should
  // crash loudly so launchd / pm2 can pick it up.
  process.stderr.write(`watcher fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
