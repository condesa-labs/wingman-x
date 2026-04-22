/**
 * Content script: tweet-detail detection + daemon `/suggestion` probe.
 *
 * Runs on every matched page (see manifest.content_scripts). CP04 scope:
 *   - Extract tweet_id from the page's canonical URL (falling back to
 *     window.location.href).
 *   - Ask the background worker for the resolved daemon port.
 *   - Fetch GET /suggestion?tweet_id=<id> and log the documented line:
 *       on 200: "[twitter-helper] suggestion available for <id>"
 *       on 404: "[twitter-helper] no suggestion for <id>"
 *     No UI rendering here — the Dock lands in CP05.
 *
 * SPA awareness:
 *   Twitter is a single-page app, so navigating /jack → /jack/status/20
 *   does not re-run content scripts. We wrap history.pushState/
 *   replaceState and listen for popstate so main() re-fires on soft
 *   navigations. We de-dupe on a Set<tweetId> so a repeated pushState
 *   to the same URL doesn't spam the log.
 */
import { parseTweetId } from "./parse-tweet-url.js";

const LOG_PREFIX = "[twitter-helper]";

/** Track tweet ids we've already probed in this page lifetime. */
const seenTweetIds = new Set<string>();

interface GetPortResponse {
  port: number | null;
  error?: string;
}

/**
 * Wrap `chrome.runtime.sendMessage` in a Promise. The MV3 API returns
 * via a callback when the listener sets `return true`, which the
 * background worker does for `get_port`.
 */
function requestPort(): Promise<GetPortResponse> {
  return new Promise((resolvePromise) => {
    try {
      chrome.runtime.sendMessage(
        { type: "get_port" },
        (response: GetPortResponse | undefined) => {
          if (chrome.runtime.lastError !== undefined) {
            resolvePromise({
              port: null,
              error: chrome.runtime.lastError.message ?? "runtime_error",
            });
            return;
          }
          resolvePromise(response ?? { port: null, error: "no_response" });
        },
      );
    } catch (err) {
      // `chrome.runtime` may be unavailable in some edge contexts (e.g.
      // detached iframe). Fail-soft: we simply skip this invocation.
      resolvePromise({
        port: null,
        error: err instanceof Error ? err.message : "sendMessage_threw",
      });
    }
  });
}

/**
 * Resolve the tweet-detail URL the page currently represents. We prefer
 * the canonical link (Twitter always sets this) because SPA navigation
 * may leave `window.location.href` lagging for a tick. Fallback to the
 * raw location so the fixture + first-load cases still work.
 */
function readPageUrl(): string {
  const canonical = document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute("href");
  return canonical ?? window.location.href;
}

async function runOnce(): Promise<void> {
  const url = readPageUrl();
  const tweetId = parseTweetId(url);
  if (tweetId === null) return;
  if (seenTweetIds.has(tweetId)) return;
  seenTweetIds.add(tweetId);

  const { port } = await requestPort();
  if (port === null) {
    // The spec documents the info-level log for 200/404; a missing port
    // is a transient error and gets a warn — CP04's "zero errors"
    // constraint only forbids console.error. A warn here is useful
    // signal for debugging and does not fail the E2E's error filter.
    console.warn(`${LOG_PREFIX} daemon port not resolved for ${tweetId}`);
    return;
  }

  try {
    const res = await fetch(
      `http://localhost:${port}/suggestion?tweet_id=${encodeURIComponent(tweetId)}`,
      { method: "GET" },
    );
    if (res.status === 200) {
      console.info(`${LOG_PREFIX} suggestion available for ${tweetId}`);
    } else if (res.status === 404) {
      console.info(`${LOG_PREFIX} no suggestion for ${tweetId}`);
    } else {
      console.warn(
        `${LOG_PREFIX} /suggestion returned ${res.status} for ${tweetId}`,
      );
    }
  } catch (err) {
    // Transport failure. Re-validating the port on failure is the
    // responsibility of CP03's fetchWithPortRetry, which is not routed
    // here intentionally — the content script talks directly to
    // http://localhost:<port> to avoid cross-origin chrome.runtime
    // round-trips on every fetch. For CP04, a warn is sufficient; a
    // future checkpoint can wire in the retry helper if needed.
    console.warn(
      `${LOG_PREFIX} /suggestion fetch failed for ${tweetId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Re-run main() on SPA-style soft navigations. This is required because
 * Twitter/X swap routes via history.pushState without reloading, so the
 * content script's initial `runOnce()` would otherwise be the only
 * invocation for the whole tab lifetime.
 */
function installSoftNavigationHook(): void {
  const fire = (): void => {
    void runOnce();
  };

  const originalPush = history.pushState;
  history.pushState = function patchedPushState(
    this: History,
    ...args: Parameters<History["pushState"]>
  ): void {
    originalPush.apply(this, args);
    fire();
  };

  const originalReplace = history.replaceState;
  history.replaceState = function patchedReplaceState(
    this: History,
    ...args: Parameters<History["replaceState"]>
  ): void {
    originalReplace.apply(this, args);
    fire();
  };

  window.addEventListener("popstate", fire);
}

installSoftNavigationHook();
void runOnce();
