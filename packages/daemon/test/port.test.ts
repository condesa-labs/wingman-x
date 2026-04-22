import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import {
  chooseAndBindPort,
  DEFAULT_PORT_RANGE,
  NoAvailablePortError,
} from "../src/port.js";
import { buildServer } from "../src/server.js";
import { setupTempStateDir } from "./helpers/tmpState.js";

/** Open a bare TCP listener on 127.0.0.1:port to simulate "port in use". */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function closeAll(servers: Server[]): Promise<void> {
  return Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  ).then(() => undefined);
}

/**
 * Use a test-only port range that does NOT overlap with the production
 * default (53827–53836). Vitest runs test files in parallel by default,
 * so two files both trying to occupy the production range would
 * race-conflict. The DEFAULT_PORT_RANGE constant test asserts the
 * production value; every bind-exercise test uses TEST_RANGE.
 *
 * Base 59800 chosen empirically — above Twitter Helper's range, below
 * the ephemeral port range (typically 49152–65535 but the upper end is
 * usually free for listen on macOS and Linux at test time).
 */
const TEST_RANGE = [59800, 59801, 59802, 59803, 59804] as const;

describe("port auto-bump", () => {
  let occupied: Server[] = [];
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let ctx: ReturnType<typeof setupTempStateDir>;

  beforeEach(() => {
    ctx = setupTempStateDir();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    await closeAll(occupied);
    occupied = [];
    ctx.cleanup();
  });

  it("exposes the default range [53827, 53836]", () => {
    expect(DEFAULT_PORT_RANGE).toEqual([
      53827, 53828, 53829, 53830, 53831, 53832, 53833, 53834, 53835, 53836,
    ]);
  });

  it("picks the first free port when the first is occupied", async () => {
    occupied.push(await occupy(TEST_RANGE[0]));
    app = await buildServer();
    const chosen = await chooseAndBindPort(app, { range: [...TEST_RANGE] });
    expect(chosen).toBe(TEST_RANGE[1]);
    expect(app.server.address()).toMatchObject({ port: TEST_RANGE[1] });
  });

  it("skips over multiple busy ports and binds the next free one", async () => {
    occupied.push(await occupy(TEST_RANGE[0]));
    occupied.push(await occupy(TEST_RANGE[1]));
    occupied.push(await occupy(TEST_RANGE[2]));
    app = await buildServer();
    const chosen = await chooseAndBindPort(app, { range: [...TEST_RANGE] });
    expect(chosen).toBe(TEST_RANGE[3]);
  });

  it("throws NoAvailablePortError when every port in the range is busy", async () => {
    for (const p of TEST_RANGE) {
      occupied.push(await occupy(p));
    }
    app = await buildServer();
    await expect(
      chooseAndBindPort(app, { range: [...TEST_RANGE] }),
    ).rejects.toBeInstanceOf(NoAvailablePortError);
  });

  it("surfaces the grep-able error message when none available", async () => {
    for (const p of TEST_RANGE) {
      occupied.push(await occupy(p));
    }
    app = await buildServer();
    try {
      await chooseAndBindPort(app, { range: [...TEST_RANGE] });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toBe(
        "no available port in 53827\u201353836",
      );
    }
  });

  it("persists the chosen port to state.json", async () => {
    app = await buildServer();
    const chosen = await chooseAndBindPort(app, { range: [...TEST_RANGE] });
    expect(chosen).toBe(TEST_RANGE[0]);

    const raw = readFileSync(ctx.statePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.port).toBe(TEST_RANGE[0]);
  });

  it("logs a grep-able listen line via the provided logger", async () => {
    app = await buildServer();
    const lines: string[] = [];
    const chosen = await chooseAndBindPort(app, {
      range: [...TEST_RANGE],
      log: (line) => lines.push(line),
    });
    expect(chosen).toBe(TEST_RANGE[0]);
    expect(
      lines.some((l) =>
        l.includes(`[daemon] listening on port ${TEST_RANGE[0]}`),
      ),
    ).toBe(true);
  });

  it("re-throws a non-EADDRINUSE error from listen instead of swallowing", async () => {
    app = await buildServer();
    // Replace app.listen with a failing stub that throws an error
    // whose `code` isn't EADDRINUSE. This exercises the
    // `lastUnexpectedError` branch.
    const boom = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    app.listen = async () => {
      throw boom;
    };

    await expect(
      chooseAndBindPort(app, { range: [TEST_RANGE[0]] }),
    ).rejects.toBe(boom);
  });

  it("tolerates persistence failures silently after a successful bind", async () => {
    // Make the state dir a path that can't be written to (a file
    // where a directory is expected). persistPort must swallow the
    // error and the bind should still succeed.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(ctx.statePath, "{}", "utf8");
    // Now force saveState to fail by replacing the state path with a
    // directory — mkdirSync inside saveState will then fail because
    // the path already exists as a file that needs to be renamed in.
    // Simpler: just unset TWITTER_HELPER_STATE_DIR to a path that
    // mkdirSync would refuse. Use /dev/null/forbidden.
    process.env.TWITTER_HELPER_STATE_DIR = "/dev/null/forbidden";

    app = await buildServer();
    const chosen = await chooseAndBindPort(app, { range: [...TEST_RANGE] });
    expect(chosen).toBe(TEST_RANGE[0]);
  });
});
