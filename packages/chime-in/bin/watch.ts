#!/usr/bin/env tsx
/**
 * `npm run watch -- [--scan-every 0|30m|2h] [--scan-now] [--since ...] [--limit N]`
 *
 * The always-on mode. One process that:
 *   1. subscribes to the Wingman daemon's event stream and serves a ♻️
 *      click within seconds of it happening (no polling, no manual
 *      `npm run regen`);
 *   2. optionally runs a full scan on an interval (`--scan-every 30m`;
 *      default 0 = scans stay manual). With an interval set, the first scan
 *      runs at start; `--scan-now` forces one at start regardless.
 * Regens and scans run in separate lanes, so a ♻️ click is served right
 * away even while a scan is in progress. Stop with Ctrl+C. Reconnects to the
 * daemon if it restarts.
 */
import "../../../scripts/load-env.mjs";
import { runRegen } from "../src/pipeline/regen.js";
import { runScan } from "../src/pipeline/scan.js";
import { computeSince, saveScanState } from "../src/state/scan-state.js";
import { connectDaemon } from "../src/wingman/daemon.js";
import { buildRuntime, buildSource, parseFlags, parseSince, printCandidates, writeScanReport } from "../src/cli/bootstrap.js";
import { isWatcherRunning, removeWatcherPid, writeWatcherPid } from "../src/cli/watcher-process.js";

// ---- flags -----------------------------------------------------------
const argv = process.argv.slice(2);
function takeFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v !== undefined && !v.startsWith("--") ? 2 : 1);
  return v;
}
function takeBool(name: string): boolean {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}
function parseInterval(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(h|m|s)?$/i.exec(v.trim());
  if (!m?.[1]) throw new Error(`--scan-every expects e.g. 2h, 45m, 0 — got ${JSON.stringify(v)}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "h").toLowerCase();
  return n * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000);
}
const scanEveryMs = parseInterval(takeFlag("--scan-every") ?? "0");
const scanNow = takeBool("--scan-now");
takeBool("--no-initial-scan"); // accepted for compatibility; no-op now that initial scans are opt-in
const flags = parseFlags(argv);
if (flags.dryRun) {
  process.stderr.write("watch mode is live by definition; drop --dry-run\n");
  process.exit(1);
}

const rt = await buildRuntime(flags, { needWatchlist: true });
const log = rt.log;
{
  const other = isWatcherRunning(rt.paths);
  if (other !== null) {
    log.info(`watch: another watcher is already running (pid ${other}); nothing to do. Stop it with npm run watch:stop.`);
    process.exit(0);
  }
  writeWatcherPid(rt.paths);
  if (process.env.CHIME_WATCH_BACKGROUND === "1") log.info(`watch: started in the background at ${new Date().toISOString()}`);
}
let daemon = await connectDaemon(rt.config.daemonPort);
log.info(`watch: Wingman daemon on port ${daemon.port}; scans ${scanEveryMs > 0 ? `every ${Math.round(scanEveryMs / 60000)} min` : "manual (npm run scan)"}; ♻️ served on click`);

// ---- two lanes: regens must never wait behind a scan --------------------
// Each lane is serial with itself. Both mutate the same in-memory state
// object and append to the same candidate log, which is safe; the only
// shared write is state.json, saved whole by whichever finishes.
const lanes: Record<"regen" | "scan", Promise<void>> = { regen: Promise.resolve(), scan: Promise.resolve() };
function enqueue(lane: "regen" | "scan", job: () => Promise<void>): void {
  lanes[lane] = lanes[lane]
    .then(job)
    .catch((err: unknown) => log.warn(`watch: ${lane} failed: ${err instanceof Error ? err.message : String(err)}`));
}

async function doRegen(): Promise<void> {
  const client = daemon.client;
  const regen = await runRegen({
    config: rt.config,
    llm: rt.llm,
    kb: rt.kb,
    policy: rt.policy,
    candidateLog: rt.candidateLog,
    state: rt.state,
    getCandidates: () => client.getCandidates(),
    postCandidates: (cs) => client.postCandidates(cs),
    log,
    quietServed: true,
  });
  if (regen.requested > 0 || regen.fills_recorded > 0) {
    saveScanState(rt.paths.state, rt.state);
    log.info(`watch: regenerated ${regen.regenerated}/${regen.requested}${regen.failed ? ` (failed ${regen.failed})` : ""}${regen.fills_recorded ? `, ${regen.fills_recorded} fill(s) recorded` : ""}`);
  }
}

async function doScan(): Promise<void> {
  const now = new Date();
  const since = flags.since ? parseSince(flags.since, now) : computeSince(rt.state, rt.config.lookbackHours, now);
  const source = buildSource(rt, flags);
  rt.state.last_scan_started_at = now.toISOString();
  saveScanState(rt.paths.state, rt.state);
  log.info(`watch: scan starting (since ${since.toISOString()})`);
  const summary = await runScan(
    {
      config: rt.config,
      watchlist: rt.watchlist,
      source,
      llm: rt.llm,
      kb: rt.kb,
      policy: rt.policy,
      themes: rt.themes,
      processed: rt.processed,
      candidateLog: rt.candidateLog,
      sink: { postCandidates: (cs) => daemon.client.postCandidates(cs) },
      log,
    },
    {
      since,
      dryRun: false,
      reprocess: flags.reprocess,
      ...(flags.handles ? { handles: flags.handles } : {}),
      ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
    },
  );
  rt.state.last_scan_completed_at = new Date().toISOString();
  saveScanState(rt.paths.state, rt.state);
  const report = writeScanReport(rt, summary);
  printCandidates(log, summary);
  log.info(`watch: scan done — ${summary.sent} sent, ${summary.llm.calls} LLM call(s), ~$${summary.llm.cost_usd.toFixed(2)}; report ${report}`);
  // --since / --reprocess apply to the first scan only; later scans are incremental.
  flags.since = undefined;
  flags.reprocess = false;
}

// ---- ♻️ clicks: debounced, one regen pass per burst ---------------------
let regenTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRegen(why: string): void {
  if (regenTimer !== null) clearTimeout(regenTimer);
  regenTimer = setTimeout(() => {
    regenTimer = null;
    log.info(`watch: ${why}`);
    enqueue("regen", doRegen);
  }, 1_500);
}

// ---- daemon event stream ---------------------------------------------
async function listen(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
      if (!res.ok || res.body === null) throw new Error(`/events returned ${res.status}`);
      log.info("watch: listening for ♻️ clicks");
      // Anything clicked while we were disconnected is still pending in
      // the daemon; sweep it now rather than wait for the next event.
      enqueue("regen", doRegen);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          handleFrame(frame);
        }
      }
      throw new Error("event stream closed");
    } catch (err) {
      log.warn(`watch: event stream lost (${err instanceof Error ? err.message : String(err)}); reconnecting in 5s`);
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        daemon = await connectDaemon(rt.config.daemonPort);
      } catch {
        // keep retrying
      }
    }
  }
}

// Safety net: a click that slips through a reconnect gap is still just a
// pending status in the daemon. One GET a minute costs nothing and never
// triggers a model call unless something is actually pending.
setInterval(() => enqueue("regen", doRegen), 60_000);

function handleFrame(frame: string): void {
  const data = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return;
  type Ev = { type?: string; id?: string; tweet_id?: string; status?: string };
  let ev: Ev | null;
  try {
    ev = JSON.parse(data) as Ev | null;
  } catch {
    return;
  }
  if (ev?.type === "candidate_updated" && ev.status === "regen_requested" && typeof ev.id === "string" && ev.id.startsWith("chime-")) {
    scheduleRegen(`♻️ on ${ev.tweet_id ?? ev.id}`);
  } else if (ev?.type) {
    log.debug(`watch: event ${ev.type}${ev.tweet_id ? " " + ev.tweet_id : ""}${ev.status ? " " + ev.status : ""}`);
  }
}

// ---- go ---------------------------------------------------------------
enqueue("regen", doRegen); // serve anything already pending
if (scanNow || scanEveryMs > 0) enqueue("scan", doScan);
if (scanEveryMs > 0) {
  setInterval(() => enqueue("scan", doScan), scanEveryMs);
}
void listen();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("watch: stopping");
    removeWatcherPid(rt.paths);
    process.exit(0);
  });
}
process.on("exit", () => removeWatcherPid(rt.paths));
