/**
 * Dock + Card action dispatcher (CP06 + CP07).
 *
 * Single entry point — `handleAction(action, context)` — that both the
 * Dock and the Card call on every icon click. Routes to:
 *   - `fill`     → fillReplyComposer + POST action=filled
 *   - `dismiss`  → POST action=dismissed + (ctx.onDismiss ?? unmountDock)
 *   - `regen`    → POST action=regen_requested + showToast 2500 ms
 *   - `quote`    → showToast "Coming in Phase 2" (no network)
 *   - `save`     → showToast "Coming in Phase 2" (no network)
 *   - `expand`   → ctx.onExpand() (no-op if undefined — CP06 Dock path)
 *   - `collapse` → ctx.onCollapse() (no-op if undefined — only the Card
 *                  wires this; the Dock has no ⇲ button)
 *
 * Why optional callbacks in the context?
 *   CP06 wired dismiss directly to `unmountDock()`. CP07 introduces the
 *   Card, whose dismiss must tear down the Card (not the Dock). Passing
 *   `onDismiss` / `onExpand` / `onCollapse` in the click-time context
 *   lets the CP07 transition controller own state swaps without forking
 *   the dispatcher or adding module-level singletons that race mount.
 *
 * Network errors are logged at `console.info`, NOT `console.error`.
 * CP04/05/06/07 all enforce a zero-error console budget; a transient
 * daemon hiccup must not crash the UI nor fail the evidence check.
 */
import { fillReplyComposer } from "./fill-reply.js";
import { unmountDock } from "./dock.js";
import { showToast } from "./toast.js";
import { parseTweetId } from "./parse-tweet-url.js";

export type DockAction =
  | "fill"
  | "dismiss"
  | "regen"
  | "quote"
  | "save"
  | "expand"
  | "collapse";

const ACTIONS_LOG_PREFIX = "[twitter-helper]";

/**
 * Everything the dispatcher needs at click-time. The content script
 * gathers this at mount-time and stashes it on the dock / card instance
 * so clicks don't need to re-fetch.
 */
export interface ActionContext {
  /** Tweet id (the path param on POST /candidates/:id/action). */
  tweetId: string;
  /** Text to type into the composer for the fill action. */
  suggestedReply: string;
  /**
   * Resolved daemon port. May be null if the background worker lost
   * the port — we silently skip the network call in that case (the
   * click still fires the local UI effect, e.g. toast / unmount).
   */
  port: number | null;
  /**
   * Optional "what to do after dismiss" hook — defaults to
   * `unmountDock()` when undefined (CP06 Dock path). The Card passes
   * a callback that unmounts the Card, so the transition controller
   * stays in charge of which shape is on-screen.
   */
  onDismiss?: () => void;
  /**
   * Optional "request expand" hook. Present only on the Dock context
   * (CP07); the Card has no ⇱ button. Undefined → click is a no-op.
   */
  onExpand?: () => void;
  /**
   * Optional "request collapse" hook. Present only on the Card context
   * (CP07); the Dock has no ⇲ button. Undefined → click is a no-op.
   */
  onCollapse?: () => void;
}

/**
 * Ask the background worker to re-fetch `/candidates` and repaint the
 * badge. Sent after any mutating action (fill / dismiss) so the count
 * reflects the user's latest intent instead of waiting for the
 * 3-minute alarm tick. Fire-and-forget — the ack is ignored and any
 * transport error is swallowed (the badge is cosmetic, never
 * load-bearing).
 */
function requestBadgeRefresh(): void {
  try {
    chrome.runtime.sendMessage({ type: "refresh_candidates" }, () => {
      // Drain `chrome.runtime.lastError` to silence "unchecked runtime
      // error" warnings when the SW is not listening.
      void chrome.runtime.lastError;
    });
  } catch {
    // sendMessage throws synchronously if `chrome.runtime` is detached
    // (rare — extension reload mid-action). Nothing to do; the alarm
    // poll will catch up within 3 min.
  }
}

/**
 * POST /candidates/:id/action with the given status. Failures log
 * `console.info`, never `console.error`.
 */
async function postAction(
  port: number,
  tweetId: string,
  action: "filled" | "dismissed" | "regen_requested",
): Promise<void> {
  try {
    const res = await fetch(
      `http://localhost:${port}/candidates/${encodeURIComponent(tweetId)}/action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      },
    );
    if (!res.ok) {
      console.info(
        `${ACTIONS_LOG_PREFIX} action POST (${action}) returned ${res.status} for ${tweetId}`,
      );
    }
  } catch (err) {
    console.info(
      `${ACTIONS_LOG_PREFIX} action POST (${action}) failed for ${tweetId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function handleAction(
  action: DockAction,
  ctx: ActionContext,
): Promise<void> {
  switch (action) {
    case "fill": {
      // URL-match guard: an SPA navigation can move the page to a new
      // tweet between Dock mount and this click. Filling the previously
      // mounted candidate's reply into the new tweet's composer would
      // silently misattribute text. Re-parse the live URL and abort if
      // it no longer matches the captured tweetId.
      const currentTweetId = parseTweetId(window.location.href);
      if (currentTweetId !== ctx.tweetId) {
        showToast(
          "Reply out of sync — reopen this candidate from the popup",
          3_000,
        );
        return;
      }
      const ok = await fillReplyComposer(ctx.suggestedReply);
      if (ok && ctx.port !== null) {
        await postAction(ctx.port, ctx.tweetId, "filled");
      }
      if (ok) {
        // Symmetry with popup: a `filled` candidate is terminal from
        // the helper's perspective (the user has the reply they asked
        // for; whether they press Tweet is purely X-side). Teardown
        // the on-page widget so the user isn't staring at a dock for
        // a candidate that's already out of the popup list.
        if (ctx.onDismiss !== undefined) {
          ctx.onDismiss();
        } else {
          unmountDock();
        }
        requestBadgeRefresh();
      }
      return;
    }
    case "dismiss": {
      // Fire the POST in parallel with the unmount — the UI effect
      // (widget goes away) should be immediate, and we don't block
      // on the network to honour the user's intent.
      if (ctx.port !== null) {
        void postAction(ctx.port, ctx.tweetId, "dismissed");
      }
      // The Card's context passes its own teardown via `onDismiss`. The
      // Dock's context leaves it undefined, falling back to the CP06
      // `unmountDock()` path.
      if (ctx.onDismiss !== undefined) {
        ctx.onDismiss();
      } else {
        unmountDock();
      }
      requestBadgeRefresh();
      return;
    }
    case "regen": {
      if (ctx.port !== null) {
        void postAction(ctx.port, ctx.tweetId, "regen_requested");
      }
      showToast(
        "Regen requested — run your agent again to pick it up",
        2_500,
      );
      return;
    }
    case "quote":
    case "save": {
      // Phase 2 stubs: visible feedback, zero network.
      showToast("Coming in Phase 2", 2_000);
      return;
    }
    case "expand": {
      // CP07: delegate to the transition controller via the context.
      // Left inert if the caller didn't wire it (e.g. a Dock mounted
      // without CP07's wrapper — defensive, not expected in production).
      ctx.onExpand?.();
      return;
    }
    case "collapse": {
      // CP07: Card's ⇲ button. Same delegation pattern as `expand`.
      ctx.onCollapse?.();
      return;
    }
  }
}
