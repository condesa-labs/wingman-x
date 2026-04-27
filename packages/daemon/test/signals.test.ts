import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { loadState } from "../src/state.js";
import { setupTempStateDir } from "./helpers/tmpState.js";

describe("signals endpoints", () => {
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
    ctx.cleanup();
  });

  describe("POST /signals", () => {
    it("creates a pending signal with server-assigned id, status, and created_at", async () => {
      app = await buildServer();

      const res = await app.inject({
        method: "POST",
        url: "/signals",
        payload: { kind: "discovery_requested" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.kind).toBe("discovery_requested");
      expect(body.status).toBe("pending");
      // UUID v4 shape — server generates this, caller cannot override.
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(typeof body.created_at).toBe("string");
      expect(body.acked_at).toBeUndefined();
    });

    it("accepts optional meta and round-trips it", async () => {
      app = await buildServer();

      const res = await app.inject({
        method: "POST",
        url: "/signals",
        payload: { kind: "discovery_requested", meta: { tier: "1", strict: true } },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.meta).toEqual({ tier: "1", strict: true });
    });

    it("rejects an unknown kind with 400", async () => {
      app = await buildServer();

      const res = await app.inject({
        method: "POST",
        url: "/signals",
        payload: { kind: "made_up_kind" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_request");
    });

    it("persists the signal through state.json", async () => {
      app = await buildServer();

      const res = await app.inject({
        method: "POST",
        url: "/signals",
        payload: { kind: "discovery_requested" },
      });
      const created = res.json();

      const reload = loadState();
      expect(Object.keys(reload.signals)).toHaveLength(1);
      expect(reload.signals[created.id]?.status).toBe("pending");
    });
  });

  describe("GET /signals", () => {
    it("returns an empty list when none exist", async () => {
      app = await buildServer();
      const res = await app.inject({ method: "GET", url: "/signals" });
      expect(res.statusCode).toBe(200);
      expect(res.json().signals).toEqual([]);
    });

    it("filters by kind and status", async () => {
      app = await buildServer();

      // Create 2 pending signals.
      const a = await app.inject({
        method: "POST",
        url: "/signals",
        payload: { kind: "discovery_requested" },
      });
      await app.inject({
        method: "POST",
        url: "/signals",
        payload: { kind: "discovery_requested" },
      });

      // Ack the first.
      await app.inject({
        method: "POST",
        url: `/signals/${a.json().id}/ack`,
      });

      const pending = await app.inject({
        method: "GET",
        url: "/signals?kind=discovery_requested&status=pending",
      });
      expect(pending.json().signals).toHaveLength(1);

      const acked = await app.inject({
        method: "GET",
        url: "/signals?kind=discovery_requested&status=acked",
      });
      expect(acked.json().signals).toHaveLength(1);

      const all = await app.inject({ method: "GET", url: "/signals" });
      // No status query defaults to pending so acked audit rows do not
      // dominate the unbounded happy path.
      expect(all.json().signals).toHaveLength(1);
    });

    it("bounds results with limit/cursor and returns a nextCursor", async () => {
      app = await buildServer();

      for (let i = 0; i < 3; i += 1) {
        await app.inject({
          method: "POST",
          url: "/signals",
          payload: { kind: "discovery_requested", meta: { index: i } },
        });
      }

      const firstPage = await app.inject({
        method: "GET",
        url: "/signals?limit=2",
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json().signals).toHaveLength(2);
      expect(typeof firstPage.json().nextCursor).toBe("string");

      const secondPage = await app.inject({
        method: "GET",
        url: `/signals?limit=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json().signals).toHaveLength(1);
      expect(secondPage.json().nextCursor).toBeUndefined();
    });

    it("rejects unknown query values with 400", async () => {
      app = await buildServer();
      const res = await app.inject({
        method: "GET",
        url: "/signals?status=bogus",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /signals/:id/ack", () => {
    it("transitions pending → acked and sets acked_at", async () => {
      app = await buildServer();

      const created = await app.inject({
        method: "POST",
        url: "/signals",
        payload: { kind: "discovery_requested" },
      });
      const id = created.json().id;

      const ack = await app.inject({
        method: "POST",
        url: `/signals/${id}/ack`,
      });

      expect(ack.statusCode).toBe(200);
      const body = ack.json();
      expect(body.status).toBe("acked");
      expect(typeof body.acked_at).toBe("string");
      // created_at preserved.
      expect(body.created_at).toBe(created.json().created_at);
    });

    it("is idempotent on re-ack", async () => {
      app = await buildServer();

      const created = await app.inject({
        method: "POST",
        url: "/signals",
        payload: { kind: "discovery_requested" },
      });
      const id = created.json().id;

      const first = await app.inject({
        method: "POST",
        url: `/signals/${id}/ack`,
      });
      const firstAcked = first.json().acked_at;

      const second = await app.inject({
        method: "POST",
        url: `/signals/${id}/ack`,
      });
      // Same record, same acked_at — the handler short-circuits instead of
      // re-stamping the timestamp (see server.ts signal ack handler).
      expect(second.statusCode).toBe(200);
      expect(second.json().status).toBe("acked");
      expect(second.json().acked_at).toBe(firstAcked);
    });

    it("returns 404 when the signal id is unknown", async () => {
      app = await buildServer();
      const res = await app.inject({
        method: "POST",
        url: "/signals/deadbeef-dead-beef-dead-beefdeadbeef/ack",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("SSE broadcast", () => {
    it("publishes a signal_added frame on POST /signals", async () => {
      // We intercept the SSE stream briefly via a manual request + abort.
      // Pattern mirrors events.test.ts / the EventBus unit test.
      app = await buildServer();
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address !== "object") {
        throw new Error("no address");
      }
      const port = address.port;

      const controller = new AbortController();
      const frames: string[] = [];
      let sawOpen = false;
      let sawSignal = false;
      let resolveOpen!: () => void;
      let resolveSignal!: () => void;
      let rejectOpen!: (err: Error) => void;
      let rejectSignal!: (err: Error) => void;
      const opened = new Promise<void>((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      });
      const signalSeen = new Promise<void>((resolve, reject) => {
        resolveSignal = resolve;
        rejectSignal = reject;
      });
      const withDeadline = async (p: Promise<void>, label: string): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            p,
            new Promise<void>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`${label} timeout`)),
                2_000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const streamDone = (async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/events`, {
            signal: controller.signal,
          });
          const reader = res.body?.getReader();
          if (!reader) throw new Error("missing SSE body");
          const decoder = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            frames.push(decoder.decode(value));
            const joined = frames.join("");
            if (!sawOpen && joined.includes(":ok")) {
              sawOpen = true;
              resolveOpen();
            }
            if (!sawSignal && joined.includes('"type":"signal_added"')) {
              sawSignal = true;
              resolveSignal();
            }
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            rejectOpen(err as Error);
            rejectSignal(err as Error);
          }
        }
      })();

      await withDeadline(opened, "SSE open");

      await fetch(`http://127.0.0.1:${port}/signals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "discovery_requested" }),
      });

      await withDeadline(signalSeen, "signal_added frame");
      controller.abort();
      await streamDone;

      const joined = frames.join("");
      expect(joined).toMatch(/"type":"signal_added"/);
      expect(joined).toMatch(/"kind":"discovery_requested"/);
    });
  });
});
