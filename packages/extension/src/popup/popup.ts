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
  postDismiss,
  type PopupCandidate,
} from "./daemon-client.js";
import { renderCard } from "./candidate-card.js";

type RootState = "loading" | "list" | "empty" | "error";

const LOG_PREFIX = "[twitter-helper]";

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
 * Open the given URL in a new active tab. `chrome.tabs.create` is
 * available to popups without the `"tabs"` permission — only
 * URL/Title/etc. readers require that permission. We AWAIT the promise
 * before closing the popup: if we `window.close()` synchronously after
 * the call, Chrome may cancel the pending tab creation with the popup's
 * own destruction, which was observed flaking the E2E's "new tab opens"
 * assertion under a fully-seeded daemon.
 */
async function openInNewTab(url: string): Promise<void> {
  try {
    await chrome.tabs.create({ url, active: true });
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
  const active = candidates.filter((c) => c.status !== "dismissed");
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

  // Fire-and-forget the POST.
  void postDismiss(port, candidate.tweet_id);

  // If the list is now empty, switch to the empty-state panel so the
  // user sees the "run your agent" copy rather than a blank list.
  if (container.childElementCount === 0) {
    setState("empty");
  }
}

/**
 * Run the full flow once: port resolution → fetch → render. Used on
 * initial load and on retry.
 */
async function runFlow(): Promise<void> {
  setState("loading");
  setPortFooter(null);

  const port = await getPortFromWorker();
  if (port === null) {
    setState("error");
    return;
  }
  setPortFooter(port);

  let candidates: PopupCandidate[];
  try {
    candidates = await fetchCandidates(port);
  } catch (err) {
    console.info(
      `${LOG_PREFIX} GET /candidates failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    setState("error");
    return;
  }

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
