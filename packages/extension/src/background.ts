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
 *  4. (D2b) Maintain a streaming fetch of the daemon's /events endpoint
 *     so server-side candidate_added events surface as OS notifications.
 *     MV3 service workers die after ~30s of inactivity; we lean on an
 *     `alarms`-based reconnect (every 60s, minimum allowed) + the SSE
 *     heartbeat traffic to keep the stream alive during active windows.
 *
 * Keep this file small on purpose.
 */
import { ensurePort, discoverPort, STORAGE_KEY } from "./port-discovery.js";
import { fetchCandidatesByPort } from "./candidates-fetch.js";
import { isActiveCandidate } from "./candidate-filter.js";

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
  void ensureEventStream();
  ensureReconnectAlarm();
  ensurePollAlarm();
  void refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  void discoverPort();
  void ensureEventStream();
  ensureReconnectAlarm();
  ensurePollAlarm();
  void refreshBadge();
});

/**
 * Reconnect alarm. Chrome's MV3 minimum alarm period for released
 * extensions is 1 minute; unpacked dev extensions can go lower but we
 * target production semantics. On each fire we attempt to (re)open the
 * event stream — `ensureEventStream` is idempotent.
 */
const RECONNECT_ALARM = "twh-reconnect-sse";
const RECONNECT_PERIOD_MINUTES = 1;

function ensureReconnectAlarm(): void {
  chrome.alarms.get(RECONNECT_ALARM, (existing) => {
    if (existing === undefined) {
      chrome.alarms.create(RECONNECT_ALARM, {
        periodInMinutes: RECONNECT_PERIOD_MINUTES,
      });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    void ensureEventStream();
    return;
  }
  if (alarm.name === POLL_CANDIDATES_ALARM) {
    void refreshBadge();
    return;
  }
});

/**
 * Periodic candidates poll + badge projection.
 *
 * Why a poll AND the SSE stream? The stream (D2b) fires an OS
 * notification the instant a new candidate arrives — it's the "alert"
 * layer. The badge is the "ambient count" layer: it must stay correct
 * even when the stream is disconnected (daemon restarted, SW woke from
 * long sleep, Chrome in power-save, etc.). A 3-min poll is the
 * simplest way to guarantee eventual consistency without reinventing
 * WebSocket reconnect state management in MV3. The user opted for 3 min
 * after we weighed WS vs. polling.
 *
 * Reusing the same alarm name on every bootstrap replaces the prior
 * schedule, so re-installs don't stack alarms.
 */
const POLL_CANDIDATES_ALARM = "twh-poll-candidates";
const POLL_CANDIDATES_PERIOD_MINUTES = 3;

/** Badge visuals — red to read as "pending work", 99+ cap. */
const BADGE_COLOUR = "#d33b3b";
const BADGE_MAX = 99;

function ensurePollAlarm(): void {
  chrome.alarms.get(POLL_CANDIDATES_ALARM, (existing) => {
    if (existing === undefined) {
      chrome.alarms.create(POLL_CANDIDATES_ALARM, {
        periodInMinutes: POLL_CANDIDATES_PERIOD_MINUTES,
      });
    }
  });
}

/**
 * Fetch `/candidates`, count the ones the user still has to act on,
 * project onto the action badge.
 *
 * Error taxonomy:
 *   - no port / scan exhausted    → clear badge (daemon not running)
 *   - transport failure on cache  → invalidate, retry once (stale-port
 *                                     recovery, same rule as popup)
 *   - any other throw             → clear badge, log at info
 *
 * Write-only: we never read the current badge to decide what to write,
 * so the function is idempotent and safe to trigger from alarm,
 * install, startup, or a refresh_candidates message.
 */
async function refreshBadge(): Promise<void> {
  const port = await ensurePort().catch(() => null);
  if (port === null) {
    await clearBadge();
    return;
  }

  try {
    const candidates = await fetchCandidatesByPort(port);
    await renderBadge(candidates.filter(isActiveCandidate).length);
    return;
  } catch (err) {
    console.info(
      `[twitter-helper/bg] GET /candidates failed on cached port ${port}: ${
        err instanceof Error ? err.message : String(err)
      } — invalidating + retrying once`,
    );
  }

  const fresh = await discoverPort({ forceFresh: true }).catch(() => null);
  if (fresh === null) {
    await clearBadge();
    return;
  }
  try {
    const candidates = await fetchCandidatesByPort(fresh);
    await renderBadge(candidates.filter(isActiveCandidate).length);
  } catch (err) {
    console.info(
      `[twitter-helper/bg] GET /candidates failed after invalidate on port ${fresh}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    await clearBadge();
  }
}

async function renderBadge(count: number): Promise<void> {
  if (count <= 0) {
    await clearBadge();
    return;
  }
  const text = count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOUR });
    await chrome.action.setBadgeText({ text });
  } catch (err) {
    // `chrome.action` is available in MV3 but can throw on very old
    // Chromes or under unusual profiles. Fail-soft: badge is cosmetic.
    console.info(
      `[twitter-helper/bg] badge render failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function clearBadge(): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // See renderBadge — fail-soft.
  }
}

/**
 * Message router. Accepts:
 *   { type: "get_port" }            — returns cached port (fast path).
 *   { type: "invalidate_port" }     — rescans the range + updates
 *                                      cache, returns the freshly-
 *                                      discovered port.
 *   { type: "refresh_candidates" }  — kicks an out-of-band badge
 *                                      refresh. Popup sends this after
 *                                      dismiss; content-script after a
 *                                      successful fill. Fire-and-
 *                                      forget: we ack `{ok:true}` so
 *                                      the caller isn't blocked on the
 *                                      re-fetch.
 *
 * We return `true` from the listener for async handlers to signal that
 * `sendResponse` is called asynchronously — documented MV3 pattern,
 * keeps the worker alive while the probe runs.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isDaemonRequestMessage(message)) {
    // Content scripts cannot fetch 127.0.0.1 from the x.com page origin
    // (Chrome local-network restrictions), so they ask the worker — which
    // holds the 127.0.0.1 host permission — to perform the request.
    void (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${message.port}${message.path}`, {
          method: message.method ?? "GET",
          ...(message.body !== undefined
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(message.body) }
            : {}),
        });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        sendResponse({
          ok: res.ok,
          status: res.status,
          identity: res.headers.get("x-twitter-helper-daemon"),
          body,
        });
      } catch (err) {
        sendResponse({
          ok: false,
          status: 0,
          identity: null,
          body: null,
          error: err instanceof Error ? err.message : "fetch_failed",
        });
      }
    })();
    return true;
  }

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

  if (isRefreshCandidatesMessage(message)) {
    sendResponse({ ok: true });
    void refreshBadge();
    return false;
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

interface RefreshCandidatesMessage {
  type: "refresh_candidates";
}

interface DaemonRequestMessage {
  type: "daemon_request";
  port: number;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
}

function isDaemonRequestMessage(value: unknown): value is DaemonRequestMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown; port?: unknown; path?: unknown };
  return (
    v.type === "daemon_request" &&
    typeof v.port === "number" &&
    typeof v.path === "string" &&
    v.path.startsWith("/")
  );
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

function isRefreshCandidatesMessage(
  value: unknown,
): value is RefreshCandidatesMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "refresh_candidates"
  );
}

// Defensive: if `chrome.storage.session` is unavailable (older Chromes),
// we still want the background script to import cleanly. This export
// makes `STORAGE_KEY` referenced, appeasing stricter tsc output.
export const _STORAGE_KEY = STORAGE_KEY;

/**
 * Module-level single-flight guard. `ensureEventStream()` is called by
 * multiple triggers (onInstalled, onStartup, alarm); we want at most
 * one active SSE reader at a time. A reader exits when the daemon
 * closes the connection, the port changes, or a fetch error tears
 * down the stream — at which point `streaming` is cleared and the next
 * trigger opens a fresh stream.
 */
let streaming = false;

const DAEMON_HEADER = "x-twitter-helper-daemon";

interface CandidateAddedEvent {
  type: "candidate_added";
  tweet_id: string;
  author_handle: string;
  match_category: "selected" | "topic" | "trending";
}

function isCandidateAdded(value: unknown): value is CandidateAddedEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "candidate_added" &&
    typeof v.tweet_id === "string" &&
    typeof v.author_handle === "string" &&
    (v.match_category === "selected" ||
      v.match_category === "topic" ||
      v.match_category === "trending")
  );
}

async function ensureEventStream(): Promise<void> {
  if (streaming) return;
  streaming = true;
  try {
    const port = await ensurePort();
    if (port === null) return;
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    // Defense in depth against a stale cached port pointing at a
    // co-located service: reject the stream if the identity header
    // is missing. Parallel to content-script's check in review-loop f14.
    if (!res.ok || res.body === null || res.headers.get(DAEMON_HEADER) === null) {
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Drain the stream until the daemon closes or the fetch errors.
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frame separator is a blank line ("\n\n"). Parse and drop
      // completed frames; keep the tail in `buffer` for the next read.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleSseFrame(frame);
      }
    }
  } catch {
    // Transport errors (daemon down, port changed, network) land here.
    // The alarm re-fires in ≤ 1 min and we try again — clean recovery
    // loop, no exponential backoff needed at this scale.
  } finally {
    streaming = false;
  }
}

function handleSseFrame(frame: string): void {
  // Collect `data:` lines per SSE spec; ignore comment lines (start
  // with ":"), `event:` and `id:` lines (we don't use them yet).
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return;
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  if (isCandidateAdded(payload)) {
    showCandidateNotification(payload);
  }
}

function showCandidateNotification(event: CandidateAddedEvent): void {
  // Notification id is keyed to tweet_id so a re-POSTed event (which
  // shouldn't happen — daemon filters by new-vs-existing — but might if
  // state.json is wiped) replaces the previous notification rather
  // than stacking. Click handler reads this id back to know which tweet.
  const id = `twh-${event.tweet_id}`;
  const category =
    event.match_category === "selected"
      ? "selected handle"
      : event.match_category === "topic"
        ? "topic match"
        : "trending";
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("notification-icon.png"),
    title: `New candidate from ${event.author_handle}`,
    message: `Matched via ${category} — click to open in popup.`,
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("twh-")) return;
  // Clear the notification first so it doesn't linger after the user
  // has already responded.
  chrome.notifications.clear(notificationId);
  // Open the extension popup in its own window. MV3 has no
  // chrome.browserAction.openPopup, but we can open popup.html as a
  // standalone window — the user can click a candidate from there.
  void chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 420,
    height: 600,
  });
});
