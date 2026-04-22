import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setupTempStateDir } from "./helpers/tmpState.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../bin/dev.ts");

function occupy(port: number): Promise<Server> {
  return new Promise((resolvePromise, rejectPromise) => {
    const srv = createServer();
    srv.once("error", rejectPromise);
    srv.listen(port, "127.0.0.1", () => resolvePromise(srv));
  });
}

function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  (child.stdout as Readable | null)?.on("data", (c) => (stdout += String(c)));
  (child.stderr as Readable | null)?.on("data", (c) => (stderr += String(c)));
  return new Promise((resolvePromise) => {
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function killChild(
  child: ChildProcess,
): Promise<void> {
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

describe("daemon binary (integration)", () => {
  let tmp: ReturnType<typeof setupTempStateDir> | undefined;
  const occupied: Server[] = [];
  let child: ChildProcess | undefined;

  afterEach(async () => {
    const c = child;
    child = undefined;
    if (c) {
      await killChild(c);
    }
    while (occupied.length) {
      const s = occupied.pop()!;
      await new Promise<void>((r) => s.close(() => r()));
    }
    tmp?.cleanup();
    tmp = undefined;
  });

  it(
    "exits non-zero with the spec message when all 10 ports are busy",
    async () => {
      tmp = setupTempStateDir();

      // Occupy every port in the range. If any of the binds fail (e.g.
      // something else on the machine already has one of these ports),
      // skip the test rather than report a false failure.
      try {
        for (let p = 53827; p <= 53836; p++) {
          occupied.push(await occupy(p));
        }
      } catch {
        // Machine-local conflict. Not something we can do anything
        // about in a unit/integration test.
        return;
      }

      child = spawn("npx", ["tsx", BIN], {
        env: {
          ...process.env,
          TWITTER_HELPER_STATE_DIR: tmp.dir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const currentChild = child;
      const { code, stderr, stdout } = await waitForExit(currentChild);
      child = undefined; // prevent afterEach from re-killing

      expect(code).not.toBe(0);
      const combined = `${stdout}${stderr}`;
      expect(combined).toContain("no available port in 53827\u201353836");
    },
    15_000,
  );
});
