/**
 * Unit tests for the port-discovery module.
 *
 * Scope: scan-cache-fetch behaviour. We inject a fake session storage
 * and fetch so the tests never touch a real Chrome runtime or a real
 * network socket. Per CP03 context: "A small unit test is fine — CP04/
 * CP08 will use [fetchWithPortRetry]."
 */
import { describe, expect, it } from "vitest";
import {
  discoverPort,
  ensurePort,
  fetchWithPortRetry,
  getCachedPort,
  PORT_RANGE,
  STORAGE_KEY,
  type SessionStorageLike,
} from "../../src/port-discovery.js";

/** In-memory session-storage stand-in. */
function makeStorage(
  initial: Record<string, unknown> = {},
): SessionStorageLike & { peek: () => Record<string, unknown> } {
  let store: Record<string, unknown> = { ...initial };
  return {
    get: async (key: string) =>
      key in store ? { [key]: store[key] } : { [key]: undefined },
    set: async (items: Record<string, unknown>) => {
      store = { ...store, ...items };
    },
    remove: async (key: string) => {
      const { [key]: _drop, ...rest } = store;
      void _drop;
      store = rest;
    },
    peek: () => ({ ...store }),
  };
}

/**
 * Body the daemon returns from GET /health — see
 * `packages/daemon/src/server.ts` — which the port probe now verifies.
 */
const DAEMON_HEALTH_BODY = JSON.stringify({ status: "ok", version: "0.1.0" });

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fetch stub that returns a valid daemon /health body for a specific port. */
function fakeFetch(okPort: number | null): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const m = /localhost:(\d+)/.exec(url);
    const port = m ? Number(m[1]) : NaN;
    if (okPort !== null && port === okPort) {
      return Promise.resolve(jsonResponse(DAEMON_HEALTH_BODY));
    }
    return Promise.resolve(new Response(null, { status: 500 }));
  }) as typeof fetch;
}

/** Fetch stub that rejects with a transport error. */
function failingFetch(): typeof fetch {
  return (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
}

describe("discoverPort", () => {
  it("returns first open port and caches it", async () => {
    const storage = makeStorage();
    const port = await discoverPort({
      storage,
      fetchImpl: fakeFetch(53829),
    });

    expect(port).toBe(53829);
    expect(storage.peek()[STORAGE_KEY]).toBe(53829);
  });

  it("returns null and clears cache when no port responds", async () => {
    const storage = makeStorage({ [STORAGE_KEY]: 53827 });
    const port = await discoverPort({
      storage,
      fetchImpl: fakeFetch(null),
    });

    expect(port).toBeNull();
    expect(storage.peek()[STORAGE_KEY]).toBeUndefined();
  });

  it("covers the documented 53827-53836 range", () => {
    expect(PORT_RANGE).toEqual([
      53827, 53828, 53829, 53830, 53831, 53832, 53833, 53834, 53835, 53836,
    ]);
  });

  it("rejects a 2xx /health whose body does not match the daemon contract", async () => {
    // A co-located local service on one of our probe ports might return a
    // 200 with an unrelated body. Before this fix the probe would cache
    // that port and every subsequent daemon request would silently route
    // to the wrong service. Now the body shape is required.
    const storage = makeStorage();
    const unrelatedOk = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const m = /localhost:(\d+)/.exec(url);
      const port = m ? Number(m[1]) : NaN;
      // Port 53830 returns 200 with a NON-daemon body — should NOT be cached.
      if (port === 53830) {
        return Promise.resolve(
          jsonResponse(JSON.stringify({ service: "not-us", ok: true })),
        );
      }
      // Port 53832 returns the real daemon body — should be cached.
      if (port === 53832) {
        return Promise.resolve(jsonResponse(DAEMON_HEALTH_BODY));
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    }) as typeof fetch;

    const port = await discoverPort({ storage, fetchImpl: unrelatedOk });
    expect(port).toBe(53832);
    expect(storage.peek()[STORAGE_KEY]).toBe(53832);
  });

  it("rejects a 2xx /health that is not JSON", async () => {
    const storage = makeStorage();
    const textOk = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const m = /localhost:(\d+)/.exec(url);
      const port = m ? Number(m[1]) : NaN;
      if (port === 53827) {
        // Some random service replies 200 + "OK" text.
        return Promise.resolve(
          new Response("OK", { status: 200, headers: { "content-type": "text/plain" } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    }) as typeof fetch;

    const port = await discoverPort({ storage, fetchImpl: textOk });
    expect(port).toBeNull();
  });

  it("coalesces concurrent calls into a single scan (review-loop f9)", async () => {
    // Without single-flight coalescing, two concurrent invalidations
    // (popup+content-script both hitting transport failure on the same
    // daemon restart) would run parallel scans whose tail cache-writes
    // could interleave — a scan that exhausts after another has cached
    // a fresh port would wipe that fresh entry.
    const storage = makeStorage();
    const probeCallsPerPort = new Map<number, number>();
    const slowFetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const m = /localhost:(\d+)/.exec(url);
      const port = m ? Number(m[1]) : NaN;
      probeCallsPerPort.set(port, (probeCallsPerPort.get(port) ?? 0) + 1);
      return new Promise<Response>((resolveFetch) => {
        // Arbitrary short delay so the two promises overlap. Without it
        // the tiny synchronous Promise chain might serialize and hide
        // the race-free guarantee we're asserting.
        setTimeout(() => {
          if (port === 53830) {
            resolveFetch(jsonResponse(DAEMON_HEALTH_BODY));
          } else {
            resolveFetch(new Response(null, { status: 500 }));
          }
        }, 5);
      });
    }) as typeof fetch;

    const [p1, p2] = await Promise.all([
      discoverPort({ storage, fetchImpl: slowFetch }),
      discoverPort({ storage, fetchImpl: slowFetch }),
    ]);

    expect(p1).toBe(53830);
    expect(p2).toBe(53830);

    // Each port probed exactly once — confirms both calls shared one
    // scan. Without coalescing we would see 2 calls for every port up
    // to and including 53830.
    for (const [port, count] of probeCallsPerPort) {
      expect(count, `port ${port} probed ${count} times`).toBe(1);
    }
  });
});

describe("getCachedPort / ensurePort", () => {
  it("returns cached port without probing", async () => {
    const storage = makeStorage({ [STORAGE_KEY]: 53830 });
    let called = false;
    const fetchImpl = ((input: string | URL | Request) => {
      called = true;
      return fakeFetch(null)(input);
    }) as typeof fetch;

    const cached = await getCachedPort({ storage });
    expect(cached).toBe(53830);

    const port = await ensurePort({ storage, fetchImpl });
    expect(port).toBe(53830);
    expect(called).toBe(false); // cache hit → no probe
  });

  it("falls back to discovery when cache is empty", async () => {
    const storage = makeStorage();
    const port = await ensurePort({
      storage,
      fetchImpl: fakeFetch(53831),
    });
    expect(port).toBe(53831);
  });
});

describe("fetchWithPortRetry", () => {
  it("uses cached port on success", async () => {
    const storage = makeStorage({ [STORAGE_KEY]: 53827 });
    const res = await fetchWithPortRetry(
      "/config",
      {},
      { storage, fetchImpl: fakeFetch(53827) },
    );
    expect(res.status).toBe(200);
  });

  it("re-scans on transport failure, then uses fresh port", async () => {
    const storage = makeStorage({ [STORAGE_KEY]: 53827 });

    let calls = 0;
    const adaptiveFetch = ((input: string | URL | Request) => {
      calls += 1;
      const url = typeof input === "string" ? input : input.toString();
      const m = /localhost:(\d+)/.exec(url);
      const port = m ? Number(m[1]) : NaN;

      // Call 1: cached-port request against 53827 -> transport fail.
      if (calls === 1) {
        expect(port).toBe(53827);
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      // Rescan: /health probe against 53830 must return a daemon-shaped
      // body so isDaemonHealthBody accepts it. /config (the actual
      // retry) returns the daemon-shaped response object regardless.
      if (port === 53830) {
        if (url.endsWith("/health")) {
          return Promise.resolve(jsonResponse(DAEMON_HEALTH_BODY));
        }
        return Promise.resolve(jsonResponse("{}"));
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    }) as typeof fetch;

    const res = await fetchWithPortRetry(
      "/config",
      {},
      { storage, fetchImpl: adaptiveFetch },
    );
    expect(res.status).toBe(200);
    // Cache moved to 53830 after rescan.
    expect(storage.peek()[STORAGE_KEY]).toBe(53830);
  });

  it("throws 'daemon not running' when both cache miss and scan fail", async () => {
    const storage = makeStorage();
    await expect(
      fetchWithPortRetry(
        "/config",
        {},
        { storage, fetchImpl: fakeFetch(null) },
      ),
    ).rejects.toThrow(/daemon not running/);
  });

  it("propagates original transport error when rescan also fails", async () => {
    const storage = makeStorage({ [STORAGE_KEY]: 53827 });
    await expect(
      fetchWithPortRetry(
        "/config",
        {},
        { storage, fetchImpl: failingFetch() },
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
