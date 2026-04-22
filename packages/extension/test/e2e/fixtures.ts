/**
 * Shared fixtures for the extension E2E suite:
 *  - spawns a real daemon (packages/daemon dev script) before each test
 *    so the background service worker has a live `/health` to hit
 *  - launches Chromium with the unpacked extension loaded
 *  - exposes helpers to resolve the extension id, open the popup page,
 *    and interact with the registered service worker
 */
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  test as base,
  chromium,
  type BrowserContext,
  type Worker,
} from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "../..");
const repoRoot = resolve(pkgRoot, "../..");
const extensionDist = join(pkgRoot, "dist");
const daemonPkg = join(repoRoot, "packages", "daemon");

/**
 * Spawn the real daemon binary via `npm --workspace=@daemon run dev`.
 * We use a disposable state dir so parallel runs don't clobber each
 * other and the user's ~/.twitter-helper is not touched.
 */
export interface DaemonHandle {
  port: number;
  stateDir: string;
  child: childProcess.ChildProcessWithoutNullStreams;
  stop: () => Promise<void>;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const stateDir = mkdtempSync(join(tmpdir(), "th-e2e-"));
  const env = {
    ...process.env,
    TWITTER_HELPER_STATE_DIR: stateDir,
  } satisfies NodeJS.ProcessEnv;

  const child = childProcess.spawn("npm", ["run", "dev", "--silent"], {
    cwd: daemonPkg,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await waitForListen(child);
  return {
    port,
    stateDir,
    child,
    stop: async () => {
      await new Promise<void>((res) => {
        child.once("exit", () => res());
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2_000);
      });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function waitForListen(
  child: childProcess.ChildProcessWithoutNullStreams,
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      reject(new Error("daemon did not emit a listen line in 10s"));
    }, 10_000);
    const onChunk = (buf: Buffer): void => {
      const line = buf.toString();
      const m = /\[daemon\] listening on port (\d+)/.exec(line);
      if (m?.[1]) {
        clearTimeout(timeout);
        child.stdout.off("data", onChunk);
        resolvePort(Number(m[1]));
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (!Number.isFinite(code)) return;
      reject(new Error(`daemon exited prematurely with code ${code}`));
    });
  });
}

export interface ExtensionCtx {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
  close: () => Promise<void>;
}

export async function launchWithExtension(): Promise<ExtensionCtx> {
  const userDataDir = mkdtempSync(join(tmpdir(), "th-chrome-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionDist}`,
      `--load-extension=${extensionDist}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=DialMediaRouteProvider",
    ],
  });

  const worker = await waitForServiceWorker(context);
  const extensionId = extractExtensionId(worker.url());

  return {
    context,
    extensionId,
    userDataDir,
    close: async () => {
      await context.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

export async function waitForServiceWorker(
  context: BrowserContext,
): Promise<Worker> {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0]!;
  return await context.waitForEvent("serviceworker", { timeout: 10_000 });
}

function extractExtensionId(workerUrl: string): string {
  const m = /^chrome-extension:\/\/([^/]+)\//.exec(workerUrl);
  if (!m?.[1]) {
    throw new Error(`unable to parse extension id from worker url: ${workerUrl}`);
  }
  return m[1];
}

export const test = base;
