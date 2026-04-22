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

/** Fetch stub that returns 200 for a specific port and 500 otherwise. */
function fakeFetch(okPort: number | null): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const m = /localhost:(\d+)/.exec(url);
    const port = m ? Number(m[1]) : NaN;
    if (okPort !== null && port === okPort) {
      return Promise.resolve(new Response(null, { status: 200 }));
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

      // Call 1: cached probe against 53827 -> fail.
      if (calls === 1) {
        expect(port).toBe(53827);
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      // Subsequent calls: scan finds 53830 responsive.
      if (port === 53830) {
        return Promise.resolve(new Response(null, { status: 200 }));
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
