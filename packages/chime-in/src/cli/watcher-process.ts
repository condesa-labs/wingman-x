import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The watcher as a background process. `npm run scan` starts one if none is
 * running so ♻️ clicks are always served without a second terminal; `npm run
 * watch:stop` ends it. Liveness is a pid file plus a signal-0 probe.
 */
export interface WatcherPaths {
  watchPid: string;
  watchLog: string;
}

export function readWatcherPid(paths: WatcherPaths): number | null {
  if (!existsSync(paths.watchPid)) return null;
  const n = Number(readFileSync(paths.watchPid, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is not ours; treat as alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isWatcherRunning(paths: WatcherPaths): number | null {
  const pid = readWatcherPid(paths);
  if (pid === null) return null;
  if (isPidAlive(pid)) return pid;
  // Stale pid file from a crash; clean it so the next start is not blocked.
  try {
    unlinkSync(paths.watchPid);
  } catch {
    // no-op
  }
  return null;
}

export function writeWatcherPid(paths: WatcherPaths): void {
  mkdirSync(dirname(paths.watchPid), { recursive: true });
  writeFileSync(paths.watchPid, `${process.pid}\n`);
}

export function removeWatcherPid(paths: WatcherPaths): void {
  try {
    if (readWatcherPid(paths) === process.pid) unlinkSync(paths.watchPid);
  } catch {
    // no-op
  }
}

/**
 * Start `bin/watch.ts` detached, with the same node binary and tsx loader
 * this process is using, stdout/stderr appended to the watch log. Returns
 * the child pid. The child writes the pid file itself once it is up.
 */
export function spawnWatcherDetached(paths: WatcherPaths, extraArgs: string[] = []): number {
  const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/src/cli
  const pkgRoot = resolve(here, "..", "..");
  const watchScript = join(pkgRoot, "bin", "watch.ts");
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  mkdirSync(dirname(paths.watchLog), { recursive: true });
  const fd = openSync(paths.watchLog, "a");
  const child = spawn(process.execPath, [tsxCli, watchScript, ...extraArgs], {
    cwd: pkgRoot,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, CHIME_WATCH_BACKGROUND: "1" },
  });
  child.unref();
  closeSync(fd);
  return child.pid ?? -1;
}

export function stopWatcher(paths: WatcherPaths): { stopped: boolean; pid: number | null } {
  const pid = isWatcherRunning(paths);
  if (pid === null) return { stopped: false, pid: null };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { stopped: false, pid };
  }
  try {
    unlinkSync(paths.watchPid);
  } catch {
    // no-op
  }
  return { stopped: true, pid };
}
