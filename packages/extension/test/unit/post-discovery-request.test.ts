import { afterEach, describe, expect, it, vi } from "vitest";
import {
  postDiscoveryRequest,
  postDiscoveryRequestWithStaleRecovery,
} from "../../src/popup/daemon-client.js";

// `postDiscoveryRequest` is fail-soft by contract: every error path
// must return false rather than throw, so the popup's click handler
// can render a status message instead of crashing the extension.
// The only side channel is `fetch` — we stub it per test.

const PORT = 53827;
const ENDPOINT = `http://127.0.0.1:${PORT}/signals`;
const NEW_PORT = 53830;

function stubFetch(
  impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  vi.stubGlobal("fetch", vi.fn(impl) as unknown as typeof fetch);
}

function stubChromeInvalidatePort(port: number | null) {
  const sendMessage = vi.fn(
    (
      message: { type: string },
      cb: (response: { port: number | null }) => void,
    ) => {
      expect(message).toEqual({ type: "invalidate_port" });
      cb({ port });
    },
  );
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: undefined,
      sendMessage,
    },
  });
  return sendMessage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("postDiscoveryRequest", () => {
  it("POSTs to /signals on the given port with the discovery_requested kind", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "abc", status: "pending" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const ok = await postDiscoveryRequest(PORT);

    expect(ok).toBe(true);
    expect(capturedUrl).toBe(ENDPOINT);
    expect(capturedInit?.method).toBe("POST");
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toEqual({ kind: "discovery_requested" });
  });

  it("returns true on any 2xx response", async () => {
    // 204 No Content can't carry a body under undici's spec-strict
    // Response constructor, so use null + status 200 here. Daemon
    // currently returns 201 with a JSON body anyway; this test is
    // about the boolean coercion, not the exact status code.
    stubFetch(async () => new Response(null, { status: 200 }));
    expect(await postDiscoveryRequest(PORT)).toBe(true);
  });

  it("returns false on 4xx without throwing", async () => {
    stubFetch(async () => new Response("bad", { status: 400 }));
    expect(await postDiscoveryRequest(PORT)).toBe(false);
  });

  it("returns false on 5xx without throwing", async () => {
    stubFetch(async () => new Response("oops", { status: 500 }));
    expect(await postDiscoveryRequest(PORT)).toBe(false);
  });

  it("returns false when fetch throws (transport / DNS / connection refused)", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await postDiscoveryRequest(PORT)).toBe(false);
  });

  it("never throws — even on a non-Error throwable", async () => {
    stubFetch(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "string-error";
    });
    // The contract is "never throw"; if it threw, this `await` would
    // reject and Vitest would surface it as a test failure.
    await expect(postDiscoveryRequest(PORT)).resolves.toBe(false);
  });
});

describe("postDiscoveryRequestWithStaleRecovery", () => {
  it("invalidates and retries once on a failed cached-port POST", async () => {
    const urls: string[] = [];
    stubFetch(async (url) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl === `http://127.0.0.1:${PORT}/signals`) {
        throw new TypeError("stale port");
      }
      return new Response(JSON.stringify({ id: "abc", status: "pending" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    stubChromeInvalidatePort(NEW_PORT);

    await expect(
      postDiscoveryRequestWithStaleRecovery(PORT),
    ).resolves.toEqual({ port: NEW_PORT, ok: true });
    expect(urls).toEqual([
      `http://127.0.0.1:${PORT}/signals`,
      `http://127.0.0.1:${NEW_PORT}/signals`,
    ]);
  });

  it("returns no-port when rediscovery exhausts the daemon range", async () => {
    stubFetch(async () => {
      throw new TypeError("stale port");
    });
    const sendMessage = stubChromeInvalidatePort(null);

    await expect(
      postDiscoveryRequestWithStaleRecovery(PORT),
    ).resolves.toEqual({ port: null, ok: null });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toEqual({ type: "invalidate_port" });
  });
});
