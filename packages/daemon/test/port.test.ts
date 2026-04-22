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

  it("picks the first free port when the default (53827) is occupied", async () => {
    occupied.push(await occupy(53827));
    app = await buildServer();
    const chosen = await chooseAndBindPort(app);
    expect(chosen).toBe(53828);
    expect(app.server.address()).toMatchObject({ port: 53828 });
  });

  it("skips over multiple busy ports and binds the next free one", async () => {
    for (const p of [53827, 53828, 53829, 53830, 53831]) {
      occupied.push(await occupy(p));
    }
    app = await buildServer();
    const chosen = await chooseAndBindPort(app);
    expect(chosen).toBe(53832);
  });

  it("throws NoAvailablePortError when all 10 ports are busy", async () => {
    for (let p = 53827; p <= 53836; p++) {
      occupied.push(await occupy(p));
    }
    app = await buildServer();
    await expect(chooseAndBindPort(app)).rejects.toBeInstanceOf(
      NoAvailablePortError,
    );
  });

  it("surfaces a grep-able error message when none available", async () => {
    for (let p = 53827; p <= 53836; p++) {
      occupied.push(await occupy(p));
    }
    app = await buildServer();
    try {
      await chooseAndBindPort(app);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toBe(
        "no available port in 53827\u201353836",
      );
    }
  });

  it("persists the chosen port to state.json", async () => {
    app = await buildServer();
    const chosen = await chooseAndBindPort(app);
    expect(chosen).toBe(53827);

    const raw = readFileSync(ctx.statePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.port).toBe(53827);
  });

  it("logs a grep-able listen line via the provided logger", async () => {
    app = await buildServer();
    const lines: string[] = [];
    const chosen = await chooseAndBindPort(app, {
      log: (line) => lines.push(line),
    });
    expect(chosen).toBe(53827);
    expect(lines.some((l) => l.includes("[daemon] listening on port 53827"))).toBe(
      true,
    );
  });
});
