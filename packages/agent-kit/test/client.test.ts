import { describe, expect, it, vi } from "vitest";
import {
  createDaemonClient,
  DaemonHttpError,
  DaemonNetworkError,
  DaemonTimeoutError,
  CandidateSchema,
  type CandidateInput,
} from "../src/index.js";

const sampleServerSignal = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-2222-4333-8444-555555555555",
  kind: "discovery_requested" as const,
  status: "pending" as const,
  created_at: "2026-04-22T10:00:00.000Z",
  ...overrides,
});

/**
 * Unit tests for the agent-kit HTTP client. Each test injects a mock
 * `fetch` so we never touch the network here — that's the integration
 * test's job.
 */

const PORT = 53827;

const sampleInput = (overrides: Partial<CandidateInput> = {}): CandidateInput => ({
  id: "uuid-1",
  tweet_id: "1790000000000000001",
  tweet_url: "https://x.com/alice_ai/status/1790000000000000001",
  author_handle: "@alice_ai",
  tweet_text: "Hot take on agents.",
  suggested_reply: "Agree — autonomy matters.",
  match_reason: "matches topic:agents in KB",
  match_category: "topic",
  kb_refs: ["library/agents.md"],
  ...overrides,
});

const sampleServerCandidate = (overrides: Record<string, unknown> = {}) => ({
  ...sampleInput(),
  created_at: "2026-04-22T10:00:00.000Z",
  status: "pending" as const,
  status_updated_at: "2026-04-22T10:00:00.000Z",
  ...overrides,
});

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createDaemonClient: base URL", () => {
  it("targets http://localhost:<port> for every method", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url.startsWith(`http://localhost:${PORT}`)).toBe(true);
      return okJson({ stored: 0 });
    });
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });
    await client.postCandidates([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("postCandidates: success path", () => {
  it("POSTs a JSON body wrapping the array and returns the server's accepted count", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "content-type": "application/json" });
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ candidates: [sampleInput()] });
      return okJson({ stored: 1 });
    });
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.postCandidates([sampleInput()]);
    expect(res.accepted).toBe(1);
  });
});

describe("getCandidates: success path", () => {
  it("GETs /candidates and validates the server-returned shape", async () => {
    const cand = sampleServerCandidate();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`http://localhost:${PORT}/candidates`);
      expect(init?.method ?? "GET").toBe("GET");
      return okJson({ candidates: [cand] });
    });
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });
    const out = await client.getCandidates();
    expect(out).toHaveLength(1);
    // Type assertion: these two fields only exist on the fully-formed
    // server shape; the client must return that, not CandidateInput.
    expect(out[0]!.status).toBe("pending");
    expect(out[0]!.created_at).toBe("2026-04-22T10:00:00.000Z");
    // And the returned object must pass the canonical zod schema
    // round-trip (defence against client accidentally narrowing).
    expect(() => CandidateSchema.parse(out[0])).not.toThrow();
  });
});

describe("postAction: success path", () => {
  it("POSTs {action} to /candidates/:id/action", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`http://localhost:${PORT}/candidates/uuid-9/action`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ action: "filled" });
      return okJson(sampleServerCandidate({ id: "uuid-9", status: "filled" }));
    });
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });
    await client.postAction("uuid-9", "filled");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("getConfig: success path", () => {
  it("GETs /config and returns {kb_dir, port}", async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ port: 53827, kb_dir: "/tmp/kb" }),
    );
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });
    const cfg = await client.getConfig();
    expect(cfg).toEqual({ port: 53827, kb_dir: "/tmp/kb" });
  });
});

describe("4xx error path", () => {
  it("throws DaemonHttpError with status, statusText, and parsed body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "invalid_request", details: [] }),
        { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" } },
      ),
    );
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });

    let caught: unknown;
    try {
      await client.postCandidates([sampleInput()]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DaemonHttpError);
    const err = caught as DaemonHttpError;
    expect(err.status).toBe(400);
    expect(err.statusText).toBe("Bad Request");
    expect(err.body).toMatchObject({ error: "invalid_request" });
    // Instance must also be a normal Error so try/catch + logging work.
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DaemonHttpError");
    expect(err.message).toContain("400");
  });

  it("exposes a text body when the server does not return JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("plain text error", {
        status: 500,
        statusText: "Server Error",
        headers: { "content-type": "text/plain" },
      }),
    );
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });
    let caught: unknown;
    try {
      await client.getCandidates();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DaemonHttpError);
    expect((caught as DaemonHttpError).body).toBe("plain text error");
  });

  it("falls back to text body when Content-Type claims JSON but payload is malformed", async () => {
    // Exercises the JSON-parse try/catch fallback in readBody — a server
    // that advertises JSON but actually emits broken JSON (a real bug
    // we've hit in other daemons) must still produce a helpful error.
    const fetchMock = vi.fn(async () =>
      new Response("{not-json", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });
    let caught: unknown;
    try {
      await client.getCandidates();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DaemonHttpError);
    expect((caught as DaemonHttpError).body).toBe("{not-json");
  });
});

describe("network failure path", () => {
  it("throws DaemonNetworkError when fetch throws a TypeError", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });

    let caught: unknown;
    try {
      await client.getCandidates();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect((caught as DaemonNetworkError).name).toBe("DaemonNetworkError");
    expect((caught as DaemonNetworkError).cause).toBeInstanceOf(TypeError);
    expect((caught as DaemonNetworkError).message).toContain("fetch failed");
  });

  it("wraps non-Error transport failures into DaemonNetworkError too", async () => {
    // Some exotic fetch polyfills throw non-Error values. The wrapper
    // must still produce a typed DaemonNetworkError without crashing on
    // `cause.message` access.
    const fetchMock = vi.fn(async () => {
      throw "socket hangup";
    });
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });
    let caught: unknown;
    try {
      await client.getCandidates();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect((caught as DaemonNetworkError).message).toBe("daemon network error");
    expect((caught as DaemonNetworkError).cause).toBe("socket hangup");
  });
});

describe("timeout behaviour", () => {
  it("throws DaemonTimeoutError when the request exceeds timeoutMs", async () => {
    // Build a fetch mock that never resolves on its own, only rejects
    // when the AbortController fires. This simulates a hung server.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });
    });

    const client = createDaemonClient(PORT, {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 25,
    });

    let caught: unknown;
    try {
      await client.getCandidates();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DaemonTimeoutError);
    expect((caught as DaemonTimeoutError).name).toBe("DaemonTimeoutError");
    expect((caught as DaemonTimeoutError).message).toMatch(/25/);
  });

  it("defaults timeout to 5000ms when not provided", async () => {
    // Smoke test: ensure the field is populated. We don't wait 5s here —
    // we only assert the AbortController is wired. This is verified by
    // checking that a signal is passed on every fetch call.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      return okJson({ candidates: [] });
    });
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });
    await client.getCandidates();
  });

  it("treats an immediate AbortError from fetch as a timeout", async () => {
    const fetchMock = vi.fn(async () => {
      const err = new Error("aborted");
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    });
    const client = createDaemonClient(PORT, {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 250,
    });

    await expect(client.getCandidates()).rejects.toBeInstanceOf(
      DaemonTimeoutError,
    );
  });
});

describe("single-attempt semantics", () => {
  it("does not retry on 5xx — throws DaemonHttpError after one attempt", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "persistence_failure" }), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createDaemonClient(PORT, { fetch: fetchMock as unknown as typeof fetch });

    await expect(client.postCandidates([sampleInput()])).rejects.toBeInstanceOf(DaemonHttpError);
    // Critically: only ONE fetch call. No retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("signals: client methods", () => {
  it("postSignal POSTs to /signals and returns the validated Signal", async () => {
    const returned = sampleServerSignal();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`http://localhost:${PORT}/signals`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        kind: "discovery_requested",
      });
      return okJson(returned);
    });
    const client = createDaemonClient(PORT, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const signal = await client.postSignal({ kind: "discovery_requested" });
    expect(signal.id).toBe(returned.id);
    expect(signal.status).toBe("pending");
  });

  it("listSignals with no filter calls /signals with no query string", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      // Exact URL — exercises the empty-suffix branch of listSignals.
      expect(url).toBe(`http://localhost:${PORT}/signals`);
      return okJson({ signals: [] });
    });
    const client = createDaemonClient(PORT, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await client.listSignals();
    expect(out).toEqual([]);
  });

  it("listSignals with only `kind` sends just kind=... in the query string", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        `http://localhost:${PORT}/signals?kind=discovery_requested`,
      );
      return okJson({ signals: [sampleServerSignal()] });
    });
    const client = createDaemonClient(PORT, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await client.listSignals({ kind: "discovery_requested" });
    expect(out).toHaveLength(1);
  });

  it("listSignals with only `status` sends just status=... in the query string", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`http://localhost:${PORT}/signals?status=pending`);
      return okJson({ signals: [sampleServerSignal()] });
    });
    const client = createDaemonClient(PORT, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await client.listSignals({ status: "pending" });
    expect(out).toHaveLength(1);
  });

  it("listSignals with kind and status preserves the query string contract", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        `http://localhost:${PORT}/signals?kind=discovery_requested&status=pending`,
      );
      return okJson({ signals: [sampleServerSignal()] });
    });
    const client = createDaemonClient(PORT, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await client.listSignals({
      kind: "discovery_requested",
      status: "pending",
    });
    expect(out).toHaveLength(1);
  });

  it("listSignals includes limit and cursor when provided", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        `http://localhost:${PORT}/signals?limit=10&cursor=cursor-1`,
      );
      return okJson({ signals: [], nextCursor: "cursor-2" });
    });
    const client = createDaemonClient(PORT, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await client.listSignals({ limit: 10, cursor: "cursor-1" });
    expect(out).toEqual([]);
  });

  it("ackSignal POSTs to /signals/:id/ack and returns the acked Signal", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        `http://localhost:${PORT}/signals/${encodeURIComponent(id)}/ack`,
      );
      expect(init?.method).toBe("POST");
      return okJson(
        sampleServerSignal({
          id,
          status: "acked",
          acked_at: "2026-04-22T10:01:00.000Z",
        }),
      );
    });
    const client = createDaemonClient(PORT, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await client.ackSignal(id);
    expect(out.status).toBe("acked");
    expect(out.acked_at).toBe("2026-04-22T10:01:00.000Z");
  });
});
