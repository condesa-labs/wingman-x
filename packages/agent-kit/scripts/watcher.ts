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
 *   2. Probe daemon ports 53827..53836 for a daemon-shaped /health response.
 *   3. Print the startup banner, register SIGINT/SIGTERM cleanup handlers.
 *   4. If --dry-run was passed, run the dry-run banner and exit.
 *   5. Otherwise loop: open `/events`, drain pending signals while the
 *      stream is subscribed, then drive `parseSseFrame` over each chunk.
 *      `signal_added` payloads go to `dispatchSignal` → `runDiscovery`.
 *      On transport error, sleep using `RECONNECT_BACKOFF_MS[attempt]`
 *      (capped at 30s) and retry.
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
import { fileURLToPath } from "node:url";
import {
  RECONNECT_BACKOFF_MS,
  SAFETY_BOUNDARY_PROMPT,
  type DispatchedSignal,
  dispatchSignal,
  runDiscovery,
  runDryRun,
  type WatcherConfig,
  type WatcherCounters,
} from "../src/watcher-core.js";
import { parseSseFrame } from "../src/sse-parser.js";
import { SignalsListResponseSchema } from "../src/signal.js";

const KB_DIR = join(homedir(), ".twitter-helper", "kb");
const PORT_START = 53827;
const PORT_END = 53836;
const DEFAULT_DRAFT_TIMEOUT_MS = 60_000;
const DEFAULT_SCRAPE_TIMEOUT_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const SUMMARY_EVERY_N = 5;
const DAEMON_IDENTITY_HEADER = "x-twitter-helper-daemon";

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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 500);
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: ctrl.signal,
      });
      if (!res.ok) continue;
      if (!hasDaemonIdentityHeader(res)) continue;
      const body = (await res.json().catch(() => null)) as unknown;
      if (isDaemonHealthBody(body)) return port;
    } catch {
      // try the next port
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function hasDaemonIdentityHeader(res: Response): boolean {
  const value = res.headers.get(DAEMON_IDENTITY_HEADER);
  return typeof value === "string" && value.length > 0;
}

function isDaemonHealthBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const rec = body as Record<string, unknown>;
  return rec.status === "ok" && typeof rec.version === "string";
}

function parsePositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const parsed = Number(raw.trim());
  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  process.stderr.write(
    `watcher warning: ${name}=${JSON.stringify(raw)} is invalid; using ${fallback}\n`,
  );
  return fallback;
}

async function drainPendingDiscoverySignals(
  ctx: {
    config: WatcherConfig;
    counters: WatcherCounters;
    log: (line: string) => void;
    trackChild: (child: ChildProcess) => () => void;
    processSignal: (
      source: "pending_drain" | "sse",
      signal: DispatchedSignal,
    ) => Promise<void>;
  },
): Promise<boolean> {
  const pending: DispatchedSignal[] = [];
  let cursor: string | undefined;

  while (true) {
    const qs = new URLSearchParams({
      kind: "discovery_requested",
      status: "pending",
      limit: "50",
    });
    if (cursor !== undefined) qs.set("cursor", cursor);

    try {
      const res = await fetch(
        `http://localhost:${ctx.config.daemonPort}/signals?${qs.toString()}`,
        { signal: AbortSignal.timeout(ctx.config.fetchTimeoutMs) },
      );
      if (!res.ok) {
        ctx.log(
          JSON.stringify({
            event: "pending_signal_drain_failed",
            status: res.status,
          }),
        );
        return false;
      }

      const parsed = SignalsListResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        ctx.log(
          JSON.stringify({
            event: "pending_signal_drain_failed",
            reason: "invalid_response",
            zod_issues: parsed.error.issues.map((i) => i.path.join(".")),
          }),
        );
        return false;
      }

      for (const signal of parsed.data.signals) {
        pending.push({
          id: signal.id,
          kind: signal.kind,
          created_at: signal.created_at,
        });
      }

      if (parsed.data.nextCursor === undefined) break;
      cursor = parsed.data.nextCursor;
    } catch (err) {
      ctx.log(
        JSON.stringify({
          event: "pending_signal_drain_failed",
          reason: "network_error",
          message: (err as Error).message ?? String(err),
        }),
      );
      return false;
    }
  }

  for (const signal of pending) {
    await ctx.processSignal("pending_drain", signal);
  }
  return true;
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes("--dry-run");

  const kb = loadKb();
  const claudeBin = findClaudeBin();

  // For dry-run we don't probe, so we use the canonical primary port for
  // the banner. CP06 manual verify explicitly states 53827.
  const probedPort = isDryRun ? PORT_START : await probeDaemonPort();
  if (probedPort === null) {
    throw new Error(`daemon /health unreachable on ${PORT_START}..${PORT_END}`);
  }
  const port = probedPort;

  const draftTimeoutMs = parsePositiveNumberEnv(
    "WATCHER_DRAFT_TIMEOUT_MS",
    DEFAULT_DRAFT_TIMEOUT_MS,
  );
  const scrapeTimeoutMs = parsePositiveNumberEnv(
    "WATCHER_SCRAPE_TIMEOUT_MS",
    DEFAULT_SCRAPE_TIMEOUT_MS,
  );
  const fetchTimeoutMs = parsePositiveNumberEnv(
    "WATCHER_FETCH_TIMEOUT_MS",
    DEFAULT_FETCH_TIMEOUT_MS,
  );

  const config: WatcherConfig = {
    daemonPort: port,
    draftTimeoutMs,
    scrapeTimeoutMs,
    fetchTimeoutMs,
    kbSystemPrompt: kb.systemPrompt,
    // Use the local tsx binary to drive the scraper. Resolve relative to
    // the repo's node_modules so the watcher works regardless of CWD.
    scrapeCommand: fileURLToPath(
      new URL("../../../node_modules/.bin/tsx", import.meta.url),
    ),
    scrapeArgs: [
      fileURLToPath(new URL("./scrape-x-handles.ts", import.meta.url)),
    ],
    claudeBin,
    summaryEveryN: SUMMARY_EVERY_N,
    toneBytes: kb.toneBytes,
    libraryFiles: kb.libraryFiles,
  };

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

  const shutdown = (sig: NodeJS.Signals): void => {
    process.stdout.write(
      `\nwatcher: ${sig} received — terminating ${inflightChildren.size} child(ren)\n`,
    );
    for (const c of inflightChildren) {
      try {
        c.kill("SIGTERM");
      } catch {
        // already dead
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const counters: WatcherCounters = {
    drafts_attempted: 0,
    drafted_ok: 0,
    drafted_failed_timeout: 0,
    drafted_failed_invalid_json: 0,
    drafted_failed_zod: 0,
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
      const probed = await probeDaemonPort();
      if (probed === null) {
        throw new Error(`daemon /health unreachable on ${PORT_START}..${PORT_END}`);
      }
      if (probed !== config.daemonPort) {
        config.daemonPort = probed;
        log(
          JSON.stringify({
            event: "daemon_port_changed",
            daemon_port: probed,
          }),
        );
      }
      const res = await fetch(`http://localhost:${config.daemonPort}/events`);
      if (!res.ok || res.body === null) {
        throw new Error(`/events returned ${res.status}`);
      }
      const reader = res.body.getReader();
      const seenSignalIds = new Set<string>();
      const processSignal = async (
        source: "pending_drain" | "sse",
        signal: DispatchedSignal,
      ): Promise<void> => {
        if (seenSignalIds.has(signal.id)) {
          log(
            JSON.stringify({
              event: "signal_skipped",
              reason: "duplicate",
              source,
              id: signal.id,
              kind: signal.kind,
            }),
          );
          return;
        }
        seenSignalIds.add(signal.id);
        log(
          JSON.stringify({
            event: "signal_received",
            source,
            id: signal.id,
            kind: signal.kind,
          }),
        );
        try {
          await runDiscovery(signal, {
            config,
            counters,
            log,
            trackChild,
          });
        } catch (err) {
          seenSignalIds.delete(signal.id);
          throw err;
        }
      };
      log(
        JSON.stringify({
          event: "subscribed",
          message: `subscribed to /events on port ${config.daemonPort}`,
        }),
      );
      const drainedPending = await drainPendingDiscoverySignals({
        config,
        counters,
        log,
        trackChild,
        processSignal,
      });
      if (!drainedPending) {
        await reader.cancel().catch(() => {});
        throw new Error("pending signal drain failed");
      }
      attempt = 0; // successful connect — reset backoff

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
            await processSignal("sse", signal);
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
