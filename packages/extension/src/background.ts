/**
 * Background service worker.
 *
 * Responsibilities (CP03 scope only):
 *  1. Discover + cache the daemon port on wake.
 *  2. Answer `get_port` messages from the popup.
 *
 * No content-script, no action-handlers, no candidate polling — those
 * land in later checkpoints. Keep this file small on purpose.
 */
import { ensurePort, discoverPort, STORAGE_KEY } from "./port-discovery.js";

/**
 * `onInstalled` fires once when the extension is loaded or updated.
 * `onStartup` fires when the browser launches. Both are cheap triggers
 * to warm the port cache so the first popup open hits the happy path.
 *
 * We intentionally do NOT re-scan on every worker wake — the spec says
 * cached port is re-validated on first fetch failure, not eagerly.
 * (See port-discovery.fetchWithPortRetry.)
 */
chrome.runtime.onInstalled.addListener(() => {
  void discoverPort();
});

chrome.runtime.onStartup.addListener(() => {
  void discoverPort();
});

/**
 * Message router. Popup sends `{ type: "get_port" }` and expects
 * `{ port: number | null }`.
 *
 * We return `true` from the listener to signal that `sendResponse` is
 * called asynchronously — this is the documented MV3 pattern and is
 * required to keep the service worker alive while the probe runs.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isGetPortMessage(message)) {
    sendResponse({ error: "unknown_message_type" });
    return false;
  }

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
});

interface GetPortMessage {
  type: "get_port";
}

function isGetPortMessage(value: unknown): value is GetPortMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "get_port"
  );
}

// Defensive: if `chrome.storage.session` is unavailable (older Chromes),
// we still want the background script to import cleanly. This export
// makes `STORAGE_KEY` referenced, appeasing stricter tsc output.
export const _STORAGE_KEY = STORAGE_KEY;
