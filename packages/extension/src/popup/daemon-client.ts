/**
 * Popup-context daemon client.
 *
 * Scope (CP08): typed `fetch` wrappers for the two endpoints the popup
 * needs — `GET /candidates` and `POST /candidates/:id/action`. Port
 * resolution goes through the background worker's cached value via
 * `chrome.runtime.sendMessage({ type: "get_port" })`, matching the
 * pattern CP03 / CP04 already use.
 *
 * We deliberately do NOT import `fetchWithPortRetry` from
 * `../port-discovery.ts` here: that helper assumes direct access to
 * `chrome.storage.session`, which works in the popup too, but the spec
 * explicitly lists the `sendMessage` path as the popup's preferred
 * route. Going through the worker keeps the popup idle while the scan
 * runs and avoids duplicate rescans if both sides race.
 */
import { fetchCandidatesByPort, type RawCandidate } from "../candidates-fetch.js";

/**
 * The popup-facing candidate type. Kept as a named alias of the shared
 * `RawCandidate` so popup code that imports `PopupCandidate` keeps
 * working without a rename sweep — the wire shape is identical.
 */
export type PopupCandidate = RawCandidate;

export interface GetPortResponse {
  port: number | null;
  error?: string;
}

/**
 * Total budget for resolving the port through the background worker.
 * Matches CP03's popup budget — kept the same so both sides feel alike.
 */
export const PORT_BUDGET_MS = 500;

/**
 * Ask the background worker for the cached daemon port. Returns `null`
 * if the worker has no port (scan exhausted) or if the RPC exceeds the
 * budget.
 */
export async function getPortFromWorker(
  budgetMs: number = PORT_BUDGET_MS,
): Promise<number | null> {
  return sendPortMessage({ type: "get_port" }, budgetMs);
}

/**
 * Tell the background worker the cached port is stale — it rescans the
 * range, updates the cache, and returns whatever port currently answers
 * (or `null` if the scan is exhausted). Callers use this after a
 * transport-failed fetch so a daemon restart onto a different port is
 * recovered within a single retry (review-loop f8).
 */
export async function invalidatePortAndRediscover(
  budgetMs: number = PORT_BUDGET_MS,
): Promise<number | null> {
  return sendPortMessage({ type: "invalidate_port" }, budgetMs);
}

/**
 * Shared implementation: send a port-related message, resolve to the
 * response's `.port` (or null) within the budget. Extracted because the
 * `get_port` and `invalidate_port` message handlers share the same
 * response shape (`{port, error?}`).
 */
function sendPortMessage(
  message: { type: "get_port" | "invalidate_port" },
  budgetMs: number,
): Promise<number | null> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolvePromise(null);
    }, budgetMs);

    chrome.runtime.sendMessage(
      message,
      (response: GetPortResponse | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // `chrome.runtime.lastError` surfaces when the worker is asleep
        // for too long or crashed. Treat as unreachable — the error
        // state will tell the user.
        if (chrome.runtime.lastError !== undefined) {
          resolvePromise(null);
          return;
        }
        resolvePromise(response?.port ?? null);
      },
    );
  });
}

/**
 * Popup entrypoint for the candidates fetch. Delegates to the shared
 * `fetchCandidatesByPort` helper (`src/candidates-fetch.ts`) so the
 * popup and the background alarm use identical wire validation — a
 * single place enforces the daemon-identity header + full-shape check.
 *
 * Throws on any transport error OR daemon-shape mismatch so the caller
 * (runFlow) can treat both as a stale-cache signal, invalidate the
 * port, and retry once (review-loop f12, f13, f14).
 */
export async function fetchCandidates(
  port: number,
): Promise<PopupCandidate[]> {
  return fetchCandidatesByPort(port);
}

/**
 * `POST /candidates/:id/action` with `{ action: "dismissed" }`.
 * Fail-soft: the caller already removed the card optimistically, so a
 * network failure is logged at `console.info` and swallowed. The spec
 * (CP08 acceptance) says dismiss "fires" the POST and removes the card
 * — it does NOT require the POST to succeed for the UI to update.
 */
export async function postDismiss(
  port: number,
  tweetId: string,
): Promise<void> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/candidates/${encodeURIComponent(tweetId)}/action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "dismissed" }),
      },
    );
    if (!res.ok) {
      console.info(
        `[twitter-helper] dismiss POST returned ${res.status} for ${tweetId}`,
      );
    }
  } catch (err) {
    console.info(
      `[twitter-helper] dismiss POST failed for ${tweetId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * `POST /signals` with `{ kind: "discovery_requested" }`. Fires when the
 * user clicks the popup's "Request discovery" button. Returns true on
 * HTTP 2xx — the caller uses that to show "Requested at HH:MM:SS"
 * confirmation or a failure note. Fail-soft: on network / non-2xx the
 * promise resolves false rather than throwing, matching the popup's
 * overall pattern of never crashing on daemon hiccups.
 */
export async function postDiscoveryRequest(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "discovery_requested" }),
    });
    if (!res.ok) {
      console.info(
        `[twitter-helper] POST /signals returned ${res.status}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.info(
      `[twitter-helper] POST /signals failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

export interface DiscoveryRequestResult {
  port: number | null;
  ok: boolean | null;
}

/**
 * POST /signals, then recover once if the popup's cached port was stale.
 * The candidates fetch path already invalidates stale ports; the discovery
 * button needs the same treatment because it also talks to the daemon via
 * the cached `currentPort`.
 */
export async function postDiscoveryRequestWithStaleRecovery(
  port: number,
): Promise<DiscoveryRequestResult> {
  const firstOk = await postDiscoveryRequest(port);
  if (firstOk) return { port, ok: true };

  const freshPort = await invalidatePortAndRediscover();
  if (freshPort === null) {
    return { port: null, ok: null };
  }
  if (freshPort === port) {
    return { port, ok: false };
  }

  return { port: freshPort, ok: await postDiscoveryRequest(freshPort) };
}
