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
import { isDaemonCandidatesListResponse } from "../daemon-shape.js";
export interface PopupCandidate {
  id: string;
  tweet_id: string;
  tweet_url: string;
  author_handle: string;
  tweet_text: string;
  suggested_reply: string;
  /**
   * Status is widened to string at the wire boundary because the daemon
   * can introduce new values (e.g. `regen_requested`) without the popup
   * needing a manifest bump. The popup only cares whether the value is
   * `"dismissed"` (filtered out) vs. anything else (shown).
   */
  status: string;
}

export interface PopupCandidatesResponse {
  candidates: PopupCandidate[];
}

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
 * `GET /candidates`. Throws on any transport error OR daemon-shape
 * mismatch so the caller (runFlow) can treat both as a stale-cache
 * signal, invalidate the port, and retry once (review-loop f12, f13).
 *
 * Shape mismatch matters because the cached port might belong to a
 * co-located local HTTP service (daemon restarted onto a different
 * auto-bumped port; old port now owned by something else). Without
 * this check, `body.candidates ?? []` would silently collapse any
 * 200 JSON into an empty list and pin the popup to the wrong
 * service indefinitely. The validator verifies the FULL Candidate
 * contract (see `packages/extension/src/daemon-shape.ts`) so a
 * squatter answering with a close-but-not-quite payload — invalid
 * `tweet_url`, wrong `status` value, missing timestamps — is
 * rejected.
 */
export async function fetchCandidates(
  port: number,
): Promise<PopupCandidate[]> {
  const res = await fetch(`http://localhost:${port}/candidates`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /candidates returned ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!isDaemonCandidatesListResponse(body)) {
    throw new Error(
      `GET /candidates response shape mismatch — cached port ${port} likely stale`,
    );
  }
  return (body as PopupCandidatesResponse).candidates;
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
      `http://localhost:${port}/candidates/${encodeURIComponent(tweetId)}/action`,
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
