/**
 * Daemon requests from content scripts, proxied through the background
 * service worker.
 *
 * Why: content scripts run in the page's origin (x.com). Modern Chrome
 * restricts requests from public-site pages to loopback / private
 * network addresses, so a direct `fetch("http://127.0.0.1:<port>/…")`
 * from the content script fails at the transport layer even though the
 * daemon is up and its CORS allows x.com. The background worker runs in
 * the extension origin, which holds host permission for 127.0.0.1 and
 * is not subject to that restriction. The popup already works for the
 * same reason.
 *
 * The worker answers `daemon_request` messages with a flattened result;
 * `toResponseLike` re-wraps it in the tiny surface the content script
 * historically used from `Response` (`status`, `headers.get`, `json()`).
 */

export interface DaemonProxyRequest {
  type: "daemon_request";
  port: number;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
}

export interface DaemonProxyResult {
  ok: boolean;
  status: number;
  /** Value of the daemon identity header, or null when absent. */
  identity: string | null;
  body: unknown;
  /** Set when the worker's fetch itself threw (transport failure). */
  error?: string;
}

export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export function daemonRequest(
  port: number,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<DaemonProxyResult> {
  const message: DaemonProxyRequest = {
    type: "daemon_request",
    port,
    path,
    method: init.method ?? "GET",
    ...(init.body !== undefined ? { body: init.body } : {}),
  };
  return new Promise((resolvePromise) => {
    try {
      chrome.runtime.sendMessage(message, (response: DaemonProxyResult | undefined) => {
        if (chrome.runtime.lastError !== undefined) {
          resolvePromise({
            ok: false,
            status: 0,
            identity: null,
            body: null,
            error: chrome.runtime.lastError.message ?? "runtime_error",
          });
          return;
        }
        resolvePromise(
          response ?? { ok: false, status: 0, identity: null, body: null, error: "no_response" },
        );
      });
    } catch (err) {
      resolvePromise({
        ok: false,
        status: 0,
        identity: null,
        body: null,
        error: err instanceof Error ? err.message : "sendMessage_threw",
      });
    }
  });
}

const DAEMON_IDENTITY_HEADER_NAME = "x-twitter-helper-daemon";

/** Adapt a proxy result to the `Response`-shaped surface the content script consumes. */
export function toResponseLike(result: DaemonProxyResult): ResponseLike {
  return {
    status: result.status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === DAEMON_IDENTITY_HEADER_NAME ? result.identity : null,
    },
    json: async () => result.body,
  };
}
