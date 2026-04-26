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
  postDiscoveryRequest,
  postDismiss,
  type PopupCandidate,
} from "./daemon-client.js";
import { renderCard } from "./candidate-card.js";
import { isActiveCandidate } from "../candidate-filter.js";
import { getSettings, setSettings } from "./settings.js";
import {
  DISCOVERY_STATUS,
  computeDiscoveryOutcome,
  statusTestidForButton,
} from "./discovery-status.js";

type RootState = "loading" | "list" | "empty" | "error";

const LOG_PREFIX = "[twitter-helper]";

/**
 * Cached port from the last successful runFlow(). The Request-discovery
 * button reads this when the user clicks — the buttons live inside the
 * list / empty state sections, both of which only become visible after
 * port resolution, so the value is always populated by the time a click
 * can fire. Held at module scope so button handlers don't need to
 * re-resolve through the worker on every click.
 */
let currentPort: number | null = null;

/** How long to lock the Request-discovery button after a click. */
const REQUEST_COOLDOWN_MS = 3000;

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
 * Tab-reuse Open: three-tier lookup so clicking Open repeatedly doesn't
 * explode your tab count.
 *
 * Tier 1 — `chrome.storage.session.last_helper_tab_id`: the id of the
 *          tab a previous popup click used. Fast path when the user
 *          hasn't closed that tab. Fails-through on stale id (tab
 *          closed / gone to a different window / browser restarted
 *          but session survived).
 *
 * Tier 2 — `chrome.tabs.query({url: [twitter, x]})`: any open Twitter /
 *          X tab in any window. Pick the most-recently-accessed to
 *          match the user's mental "the Twitter tab I was just on."
 *          Covers the common case where the stored id went stale
 *          because the user closed the helper tab after tweeting.
 *
 * Tier 3 — `chrome.tabs.create`: no Twitter tab anywhere; spawn a
 *          fresh one. This is the only path that grows the tab count.
 *
 * Gate: `settings.reuseTab` (default true). When false, skip tiers 1-2
 * and always Tier-3, preserving the pre-refactor behaviour for users
 * who prefer the per-click new-tab semantics.
 *
 * We AWAIT the chrome.* call before `window.close()` — closing the
 * popup synchronously was previously observed to cancel pending tab
 * operations in-flight (CP10 E2E flake).
 */
async function openInTab(url: string): Promise<void> {
  const settings = await getSettings();

  if (settings.reuseTab) {
    // Tier 1: stored id.
    const storedId = await getLastHelperTabId();
    if (storedId !== null) {
      try {
        await chrome.tabs.update(storedId, { url, active: true });
        await focusTabWindow(storedId);
        window.close();
        return;
      } catch {
        // Stored id is stale (tab closed). Fall through.
      }
    }

    // Tier 2: any open twitter.com / x.com tab.
    try {
      const tabs = await chrome.tabs.query({
        url: ["https://twitter.com/*", "https://x.com/*"],
      });
      if (tabs.length > 0) {
        // Prefer most-recently-accessed. `lastAccessed` was added in
        // Chrome 121; older Chromes leave it undefined — those fall
        // back to query order, which is close enough.
        const sorted = [...tabs].sort(
          (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
        );
        const target = sorted[0];
        if (target !== undefined && typeof target.id === "number") {
          await chrome.tabs.update(target.id, { url, active: true });
          if (typeof target.windowId === "number") {
            await chrome.windows
              .update(target.windowId, { focused: true })
              .catch(() => {});
          }
          await setLastHelperTabId(target.id);
          window.close();
          return;
        }
      }
    } catch {
      // `tabs` permission might be missing on older profiles. Fall through.
    }
  }

  // Tier 3: create fresh (or toggle is off).
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

/** Bring the host window for a tab to the foreground, best-effort. */
async function focusTabWindow(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // Tab might have been closed between update and get; no-op.
  }
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
        void openInTab(c.tweet_url);
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
  currentPort = port;
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

/**
 * Wire the "Reuse existing Twitter tab" checkbox: reflect the current
 * setting on popup open + write through on change. Fire-and-forget —
 * a slow `chrome.storage.local.set` must not block the click.
 */
async function wireReuseTabToggle(): Promise<void> {
  const toggle = document.querySelector<HTMLInputElement>(
    "[data-testid='twh-reuse-tab-toggle']",
  );
  if (toggle === null) return;
  const current = await getSettings();
  toggle.checked = current.reuseTab;
  toggle.addEventListener("change", () => {
    void setSettings({ reuseTab: toggle.checked });
  });
}

/**
 * Wire the "Request discovery" buttons (one in each of list + empty
 * state). Clicking POSTs a `discovery_requested` signal to the daemon —
 * the agent's discover skill reads pending signals on its next session
 * and prioritises this run. Success / failure flashes into the adjacent
 * `.request-status` div; the button is disabled for
 * `REQUEST_COOLDOWN_MS` to keep the user from spamming the signal list.
 */
function wireRequestDiscovery(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    "[data-testid='twh-request-discovery-empty']," +
      " [data-testid='twh-request-discovery-list']",
  );
  for (const btn of Array.from(buttons)) {
    const buttonTestid = btn.dataset.testid ?? "";
    const statusTestid = statusTestidForButton(buttonTestid);
    // Resolve the status div by derived testid rather than DOM siblings —
    // robust to whitespace / comment nodes between the button and div in
    // the rendered HTML. Falls back to nextElementSibling so we never
    // silently lose the status output if a future markup tweak breaks
    // the testid pattern.
    const statusEl =
      (statusTestid !== null
        ? document.querySelector<HTMLElement>(
            `[data-testid='${statusTestid}']`,
          )
        : null) ??
      (btn.nextElementSibling instanceof HTMLElement
        ? btn.nextElementSibling
        : null);

    btn.addEventListener("click", async () => {
      // No-port branch: fast path, no POST, no cooldown.
      if (currentPort === null) {
        if (statusEl !== null) {
          statusEl.textContent = DISCOVERY_STATUS.noPort;
        }
        return;
      }
      // In-flight: lock the button immediately and show "Requesting…"
      // so a slow daemon doesn't leave the UI looking inert between
      // click and POST resolution.
      btn.disabled = true;
      if (statusEl !== null) {
        statusEl.textContent = DISCOVERY_STATUS.inFlight;
      }

      const ok = await postDiscoveryRequest(currentPort);
      const outcome = computeDiscoveryOutcome(currentPort, ok, new Date());
      if (statusEl !== null) {
        statusEl.textContent = outcome.status;
      }
      // Only hold the cooldown for outcomes where a POST actually
      // happened. The `noPort` early-return is unreachable here
      // because we just checked currentPort, but keep the guard so
      // the contract matches `computeDiscoveryOutcome` exactly.
      if (outcome.shouldHoldDisabled) {
        setTimeout(() => {
          btn.disabled = false;
        }, REQUEST_COOLDOWN_MS);
      } else {
        btn.disabled = false;
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  wireRetry();
  void wireReuseTabToggle();
  wireRequestDiscovery();
  void runFlow();
});
