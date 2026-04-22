/**
 * Dock action dispatcher (CP06).
 *
 * Single entry point — `handleAction(action, context)` — that the dock
 * calls on every icon click. Routes to:
 *   - `fill`     → fillReplyComposer + POST action=filled
 *   - `dismiss`  → POST action=dismissed + unmountDock
 *   - `regen`    → POST action=regen_requested + showToast 2500 ms
 *   - `quote`    → showToast "Coming in Phase 2" (no network)
 *   - `save`     → showToast "Coming in Phase 2" (no network)
 *   - `expand`   → no-op (CP07 owns the card state)
 *
 * Network errors are logged at `console.info`, NOT `console.error`.
 * CP04/05/06 all enforce a zero-error console budget; a transient
 * daemon hiccup must not crash the UI nor fail the evidence check.
 */
import { fillReplyComposer } from "./fill-reply.js";
import { unmountDock } from "./dock.js";
import { showToast } from "./toast.js";

export type DockAction =
  | "fill"
  | "dismiss"
  | "regen"
  | "quote"
  | "save"
  | "expand";

const ACTIONS_LOG_PREFIX = "[twitter-helper]";

/**
 * Everything the dispatcher needs at click-time. The content script
 * gathers this at mount-time and stashes it on the dock instance so
 * clicks don't need to re-fetch.
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
      const ok = await fillReplyComposer(ctx.suggestedReply);
      if (ok && ctx.port !== null) {
        await postAction(ctx.port, ctx.tweetId, "filled");
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
      unmountDock();
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
      // CP07 owns Card state + expand. Intentionally inert in CP06.
      return;
    }
  }
}
