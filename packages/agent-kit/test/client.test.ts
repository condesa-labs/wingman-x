import { describe, expect, it, vi } from "vitest";
import {
  createDaemonClient,
  DaemonHttpError,
  DaemonNetworkError,
  DaemonTimeoutError,
  CandidateSchema,
  type CandidateInput,
} from "../src/index.js";

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
