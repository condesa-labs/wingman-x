/**
 * Background service worker.
 *
 * Responsibilities:
 *  1. Discover + cache the daemon port on wake.
 *  2. Answer `get_port` messages from popup / content-script.
 *  3. Answer `invalidate_port` messages by dropping the cache and
 *     rescanning — called by callers after a transport-failed fetch so
 *     a daemon restart onto a different auto-bumped port recovers
 *     within a single retry (review-loop f8).
 *
 * Keep this file small on purpose.
 */
import { ensurePort, discoverPort, STORAGE_KEY } from "./port-discovery.js";

/**
 * `onInstalled` fires once when the extension is loaded or updated.
 * `onStartup` fires when the browser launches. Both are cheap triggers
 * to warm the port cache so the first popup open hits the happy path.
 *
 * We intentionally do NOT re-scan on every worker wake — recovery from
 * a stale cache happens on demand via the `invalidate_port` message
 * that popup / content-script send after a transport failure.
 */
chrome.runtime.onInstalled.addListener(() => {
  void discoverPort();
});

chrome.runtime.onStartup.addListener(() => {
  void discoverPort();
});

/**
 * Message router. Accepts:
 *   { type: "get_port" }        — returns cached port (fast path).
 *   { type: "invalidate_port" } — rescans the range + updates cache,
 *                                  returns the freshly-discovered port.
 *
 * We return `true` from the listener to signal that `sendResponse` is
 * called asynchronously — this is the documented MV3 pattern and is
 * required to keep the service worker alive while the probe runs.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isGetPortMessage(message)) {
    void (async () => {
      try {
        const port = await ensurePort();
        sendResponse({ port });
      } catch (err) {
        sendResponse({
          port: null,
          error: err instanceof Error ? err.message : "unknown_error",
        });
      }
    })();
    return true;
  }

  if (isInvalidatePortMessage(message)) {
    void (async () => {
      try {
        // `forceFresh: true` bypasses a warm-up scan that may have
        // started while the daemon was down and already probed past
        // its eventual port — otherwise the invalidate would inherit
        // that stale null result (review-loop f10). The new scan runs
        // in its own generation; any older in-flight scan still
        // completes but skips its tail storage writes.
        const port = await discoverPort({ forceFresh: true });
        sendResponse({ port });
      } catch (err) {
        sendResponse({
          port: null,
          error: err instanceof Error ? err.message : "unknown_error",
        });
      }
    })();
    return true;
  }

  sendResponse({ error: "unknown_message_type" });
  return false;
});

interface GetPortMessage {
  type: "get_port";
}

interface InvalidatePortMessage {
  type: "invalidate_port";
}

function isGetPortMessage(value: unknown): value is GetPortMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "get_port"
  );
}

function isInvalidatePortMessage(
  value: unknown,
): value is InvalidatePortMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "invalidate_port"
  );
}

// Defensive: if `chrome.storage.session` is unavailable (older Chromes),
// we still want the background script to import cleanly. This export
// makes `STORAGE_KEY` referenced, appeasing stricter tsc output.
export const _STORAGE_KEY = STORAGE_KEY;
