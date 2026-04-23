/**
 * Popup entrypoint — CP08 candidate list.
 *
 * Flow (on open):
 *   1. Show loading skeleton.
 *   2. Ask the background worker for the cached daemon port.
 *   3. If null → show the error state + retry button. Retry re-runs step 2.
 *   4. Fetch `GET /candidates`. On failure → error state.
 *   5. Filter out dismissed candidates. Empty list → empty state
 *      (CP03 copy preserved verbatim). Non-empty → render one card
 *      per candidate.
 *
 * Actions on each card:
 *   - "Open"    → `chrome.tabs.create({ url: tweet_url, active: true })`
 *                 then close the popup.
 *   - "Dismiss" → POST `/candidates/:id/action` with `{action:"dismissed"}`,
 *                 remove the card from the DOM optimistically. If the
 *                 remaining card count reaches zero, switch to the empty
 *                 state. Network errors are logged at `console.info`
 *                 (fail-soft per spec).
 */
import {
  fetchCandidates,
  getPortFromWorker,
  invalidatePortAndRediscover,
  postDismiss,
  type PopupCandidate,
} from "./daemon-client.js";
import { renderCard } from "./candidate-card.js";
import { isActiveCandidate } from "../candidate-filter.js";

type RootState = "loading" | "list" | "empty" | "error";

const LOG_PREFIX = "[twitter-helper]";

/**
 * Session-storage key for the id of the last helper tab we opened.
 * Used to implement the singleton-tab UX: the next Open click reuses
 * this tab via `chrome.tabs.update` instead of creating a new one, so
 * helper tabs don't accumulate across sessions. The id is cleared
 * implicitly when the browser closes (storage.session scope).
 */
const LAST_TAB_KEY = "last_helper_tab_id";

async function getLastHelperTabId(): Promise<number | null> {
  try {
    const entry = await chrome.storage.session.get(LAST_TAB_KEY);
    const id = entry[LAST_TAB_KEY];
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

async function setLastHelperTabId(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.set({ [LAST_TAB_KEY]: tabId });
  } catch {
    // Fail-soft: losing the stored id just means the next click opens
    // a fresh tab instead of reusing one. No user-visible breakage.
  }
}

function setState(state: RootState): void {
  const root = document.querySelector<HTMLElement>(".root");
  if (root) root.dataset.state = state;
}

/**
 * Write "Connected to daemon on port N" into every footer that carries
 * a port-status test id. Two states need this footer: the empty state
 * (preserves CP03's `data-testid="port-status"` so CP03's regression
 * still passes) and the list state (uses a distinct id to avoid
 * Playwright strict-mode collisions).
 */
function setPortFooter(port: number | null): void {
  const footers = document.querySelectorAll<HTMLElement>(
    "[data-testid='port-status'], [data-testid='twh-popup-port-status']",
  );
  const text = port === null ? "" : `Connected to daemon on port ${port}`;
  for (const f of footers) f.textContent = text;
}

function clearCards(container: HTMLElement): void {
  while (container.firstChild) container.removeChild(container.firstChild);
}

/**
 * Singleton-tab Open: reuse the previously-opened helper tab if it
 * still exists, otherwise create a fresh one.
 *
 * Flow:
 *   1. Read the stored tab id (if any) from `chrome.storage.session`.
 *   2. Try `chrome.tabs.update(id, {url, active:true})` — on success,
 *      the same tab navigates to the new tweet. No new tab is spawned.
 *   3. If the stored id is stale (user manually closed the tab, moved
 *      it to another profile, etc.), `update` rejects. Fall through to
 *      `chrome.tabs.create` and remember the new id.
 *
 * We AWAIT the chrome.* call before `window.close()` — closing the
 * popup synchronously was previously observed to cancel pending tab
 * operations in-flight (CP10 E2E flake).
 */
async function openInNewTab(url: string): Promise<void> {
  const storedId = await getLastHelperTabId();
  if (storedId !== null) {
    try {
      await chrome.tabs.update(storedId, { url, active: true });
      window.close();
      return;
    } catch {
      // Stored tab no longer exists — fall through to create.
    }
  }

  try {
    const created = await chrome.tabs.create({ url, active: true });
    if (typeof created.id === "number") {
      await setLastHelperTabId(created.id);
    }
  } catch (err) {
    console.info(
      `${LOG_PREFIX} chrome.tabs.create failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  window.close();
}

/**
 * Main render pass for the list state. Returns true if any cards were
 * rendered, false if the filtered list is empty.
 */
function renderList(
  port: number,
  candidates: PopupCandidate[],
  container: HTMLElement,
): boolean {
  clearCards(container);
  const active = candidates.filter(isActiveCandidate);
  if (active.length === 0) return false;

  for (const candidate of active) {
    const card = renderCard(candidate, {
      onOpen: (c) => {
        void openInNewTab(c.tweet_url);
      },
      onDismiss: (c) => handleDismiss(c, port, container),
    });
    container.append(card);
  }
  return true;
}

function handleDismiss(
  candidate: PopupCandidate,
  port: number,
  container: HTMLElement,
): void {
  // Optimistic removal: pull the card from the DOM immediately. The
  // POST runs in the background; failures log to console.info but do
  // NOT re-insert the card. Spec: dismiss is fail-soft.
  const card = container.querySelector<HTMLElement>(
    `[data-testid="twh-popup-card"][data-id="${CSS.escape(candidate.tweet_id)}"]`,
  );
  card?.remove();

  // Fire-and-forget the POST + ask the background worker to refresh
  // the badge count. Without the refresh, the badge stays stale until
  // the next 3-minute alarm tick — visible drift on a dismiss the
  // user just performed.
  void postDismiss(port, candidate.tweet_id);
  chrome.runtime.sendMessage({ type: "refresh_candidates" }, () => {
    // Swallow chrome.runtime.lastError: the ack is optional.
    void chrome.runtime.lastError;
  });

  // If the list is now empty, switch to the empty-state panel so the
  // user sees the "run your agent" copy rather than a blank list.
  if (container.childElementCount === 0) {
    setState("empty");
  }
}

/**
 * Run the full flow once: port resolution → fetch → render. Used on
 * initial load and on retry.
 *
 * On a transport failure we assume the cached port is stale (typical
 * case: the daemon restarted onto a different auto-bumped port after a
 * crash). We ask the background worker to invalidate + rescan, then try
 * the fetch again exactly once. If the second attempt also fails, we
 * drop to the error state — the retry button re-runs this whole flow.
 */
async function runFlow(): Promise<void> {
  setState("loading");
  setPortFooter(null);

  const initialPort = await getPortFromWorker();
  if (initialPort === null) {
    setState("error");
    return;
  }

  const { port, candidates } = await fetchWithStaleRecovery(initialPort);
  if (port === null || candidates === null) {
    setState("error");
    return;
  }
  setPortFooter(port);

  const container = document.querySelector<HTMLElement>(
    "[data-testid='twh-popup-cards']",
  );
  if (!container) {
    // Defensive — the HTML shell is under our control so this is a
    // build-time invariant, but we don't want an unhandled null if the
    // markup diverges.
    setState("error");
    return;
  }

  const rendered = renderList(port, candidates, container);
  setState(rendered ? "list" : "empty");
}

/**
 * One-shot fetch + stale-port recovery. Returns the port used and the
 * candidates list; either is null if we couldn't recover.
 */
async function fetchWithStaleRecovery(
  initialPort: number,
): Promise<{ port: number | null; candidates: PopupCandidate[] | null }> {
  try {
    return { port: initialPort, candidates: await fetchCandidates(initialPort) };
  } catch (err) {
    console.info(
      `${LOG_PREFIX} GET /candidates failed on cached port ${initialPort}: ${
        err instanceof Error ? err.message : String(err)
      } — invalidating + retrying once`,
    );
  }

  const fresh = await invalidatePortAndRediscover();
  if (fresh === null) {
    return { port: null, candidates: null };
  }

  try {
    return { port: fresh, candidates: await fetchCandidates(fresh) };
  } catch (err) {
    console.info(
      `${LOG_PREFIX} GET /candidates failed after invalidate on port ${fresh}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { port: null, candidates: null };
  }
}

function wireRetry(): void {
  const retry = document.querySelector<HTMLButtonElement>(
    "[data-testid='twh-popup-retry']",
  );
  retry?.addEventListener("click", () => {
    void runFlow();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireRetry();
  void runFlow();
});
