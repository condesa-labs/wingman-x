/**
 * Typed errors thrown by `createDaemonClient`. Callers can `instanceof`
 * or `switch (err.name)` to distinguish recovery paths:
 *
 *   - `DaemonHttpError` — the daemon responded with a non-2xx status. A
 *     stable `.status` field supports `switch (err.status) { ... }`
 *     fan-out (e.g. 404 → "unknown candidate", 400 → "fix input").
 *   - `DaemonTimeoutError` — the request's `AbortController` fired
 *     before the server responded. Single-attempt semantics: we do not
 *     retry.
 *   - `DaemonNetworkError` — the transport itself failed (DNS refusal,
 *     connection reset, etc.). These surface as `TypeError` from
 *     `fetch`; we re-wrap them so callers get a typed error rather than
 *     a bare TypeError.
 *
 * All three extend the native `Error` so they Just Work in `throw /
 * catch / log` call sites that only care about `message`.
 */

export class DaemonHttpError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`daemon returned ${status} ${statusText}`);
    this.name = "DaemonHttpError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export class DaemonTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`daemon request timed out after ${timeoutMs}ms`);
    this.name = "DaemonTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class DaemonNetworkError extends Error {
  /**
   * The underlying transport error thrown by `fetch`. Preserved so
   * callers can drill into `.cause?.code` for platform-specific
   * diagnostics when helpful.
   */
  public override readonly cause: unknown;

  constructor(cause: unknown) {
    const detail =
      cause instanceof Error && cause.message ? `: ${cause.message}` : "";
    super(`daemon network error${detail}`);
    this.name = "DaemonNetworkError";
    this.cause = cause;
  }
}
