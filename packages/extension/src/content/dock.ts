/**
 * Dock widget renderer (CP05).
 *
 * Mounts a fixed-position toolbar with one drag handle and six action
 * icons. CP05 scope is render + drag-persist only — the action buttons
 * are visually present but intentionally inert. Click handlers land in
 * CP06, Card state + expand behaviour in CP07.
 *
 * Contract with the content script:
 *   - `mountDock()` is idempotent. Calling it twice with the same
 *     tweet_id is a no-op; calling it for a different tweet_id
 *     replaces the existing Dock.
 *   - `unmountDock()` removes the Dock and tears down listeners. Used
 *     on SPA pushState to a non-tweet page.
 *
 * Why `document.createElement` over `innerHTML`?
 *   Twitter ships with a strict CSP that would block inline HTML with
 *   event handlers. We create elements imperatively and attach
 *   listeners via `addEventListener` so the code is CSP-safe today and
 *   portable to the real twitter.com tomorrow.
 */
import { attachDrag, applyPosition } from "./drag.js";
import {
  loadPosition,
  savePosition,
  clampToViewport,
  type LocalStorageLike,
  type WidgetPosition,
} from "./position-store.js";
import { handleAction, type DockAction } from "./actions.js";
import { clearToast } from "./toast.js";

/** Root id — stable for E2E selectors and for idempotent re-mount. */
export const DOCK_ID = "twh-dock";

/**
 * Default right-edge anchor position (spec Open Question #3: "MVP ships
 * with right-edge anchor"). These match the CSS rule `.twh-dock-default`
 * and let us show the Dock without measuring it.
 */
const DEFAULT_OFFSET_RIGHT = 16;
const DEFAULT_OFFSET_TOP = 96;

export interface DockOptions {
  /** Tweet id this Dock instance belongs to — used for idempotence. */
  tweetId: string;
  /**
   * The raw /suggestion payload. Stashed on the element via
   * `dataset.suggestion` so CP06 can read it without re-fetching.
   */
  suggestionPayload: unknown;
  /**
   * Resolved daemon port for POST /candidates/:id/action. `null`/
   * omitted disables the network side of each action — the UI effect
   * (toast, unmount, composer fill) still runs so offline/dev-mode is
   * usable without the daemon.
   */
  port?: number | null;
  /** Storage override for tests. */
  storage?: LocalStorageLike;
}

/** Per-instance teardown hook — cleared on unmount. */
let detachDrag: (() => void) | null = null;
/** Tweet id tracker for idempotence. */
let mountedTweetId: string | null = null;

/**
 * Create (or replace) the Dock in the page DOM. Returns the root
 * element so tests can introspect it.
 */
export async function mountDock(
  options: DockOptions,
): Promise<HTMLElement | null> {
  // Same tweet id and Dock already in the DOM → no-op.
  if (
    mountedTweetId === options.tweetId &&
    document.getElementById(DOCK_ID) !== null
  ) {
    return document.getElementById(DOCK_ID);
  }

  // Different tweet id or stale mount → unmount first so we start clean.
  unmountDock();

  const root = buildDockElement(options);
  document.body.appendChild(root);

  // Apply persisted position if any, clamped to current viewport. If
  // nothing persisted, leave the CSS right-edge default in place.
  const saved = await loadPosition({ storage: options.storage });
  if (saved !== null) {
    const rect = root.getBoundingClientRect();
    const clamped = clampToViewport(saved, {
      width: window.innerWidth,
      height: window.innerHeight,
      dockWidth: rect.width,
      dockHeight: rect.height,
    });
    applyPosition(root, clamped);
  }

  // Wire drag on the handle. persist the released position.
  const handle = root.querySelector<HTMLElement>(
    '[data-testid="twh-drag-handle"]',
  );
  if (handle !== null) {
    detachDrag = attachDrag({
      target: root,
      handle,
      onDrop: (pos: WidgetPosition) => {
        void savePosition(pos, { storage: options.storage });
      },
    });
  }

  // CP06: wire click handlers for each action icon. The handler uses a
  // snapshot of the tweet_id / suggested_reply / port captured at mount
  // time so each click is self-contained — no extra fetch needed.
  const suggestedReply = extractSuggestedReply(options.suggestionPayload);
  const port = options.port ?? null;
  const actionButtons = root.querySelectorAll<HTMLButtonElement>(
    "button.twh-action",
  );
  for (const btn of actionButtons) {
    const raw = btn.dataset["action"];
    if (raw === undefined) continue;
    const action = raw as DockAction;
    btn.addEventListener("click", () => {
      void handleAction(action, {
        tweetId: options.tweetId,
        suggestedReply,
        port,
      });
    });
  }

  mountedTweetId = options.tweetId;
  return root;
}

/** Remove the Dock and tear down drag listeners. Safe to call twice. */
export function unmountDock(): void {
  if (detachDrag !== null) {
    detachDrag();
    detachDrag = null;
  }
  mountedTweetId = null;
  document.getElementById(DOCK_ID)?.remove();
  // Drop any lingering toast so dismissing the Dock during a regen toast
  // doesn't leave a "regen requested" note hovering on an empty page.
  clearToast();
}

/**
 * Best-effort extractor for the `suggested_reply` string from the
 * /suggestion payload. Falls back to an empty string if the payload
 * shape is unexpected — `handleAction("fill", ...)` will still run and
 * return `false` from fillReplyComposer, which is the documented
 * no-op contract for a missing suggestion.
 */
function extractSuggestedReply(payload: unknown): string {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "suggested_reply" in payload &&
    typeof (payload as { suggested_reply: unknown }).suggested_reply === "string"
  ) {
    return (payload as { suggested_reply: string }).suggested_reply;
  }
  return "";
}

/**
 * Build the Dock subtree imperatively (no innerHTML) and inject the
 * stylesheet if it has not been injected yet. The stylesheet is
 * registered via the manifest's `content_scripts[].css` entry for
 * real-Twitter CSP safety, but we also guard against missing CSS
 * (e.g. test harness using the raw JS directly) by injecting a
 * minimal fallback via a <style> tag on first mount.
 */
function buildDockElement(options: DockOptions): HTMLElement {
  const root = document.createElement("div");
  root.id = DOCK_ID;
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Twitter Helper Dock");
  root.classList.add("twh-dock-default");
  // Stash the payload so CP06 can read it without re-fetching.
  try {
    root.dataset["suggestion"] = JSON.stringify(options.suggestionPayload);
  } catch {
    // Payload isn't JSON-serialisable → skip; CP06 can fall back to fetch.
  }

  const handle = document.createElement("span");
  handle.className = "twh-handle";
  handle.dataset["testid"] = "twh-drag-handle";
  handle.setAttribute("aria-label", "Drag Twitter Helper Dock");
  handle.setAttribute("role", "button");
  handle.textContent = "⋮⋮";
  root.appendChild(handle);

  const actions: ReadonlyArray<{
    action: string;
    testId: string;
    label: string;
    glyph: string;
    primary?: boolean;
  }> = [
    {
      action: "fill",
      testId: "twh-fill",
      label: "Fill reply",
      glyph: "\u270D\uFE0F",
      primary: true,
    },
    {
      action: "quote",
      testId: "twh-quote",
      label: "Quote reply",
      glyph: "\uD83D\uDCAC",
    },
    {
      action: "save",
      testId: "twh-save",
      label: "Save for later",
      glyph: "\uD83D\uDD16",
    },
    {
      action: "regen",
      testId: "twh-regen",
      label: "Regenerate",
      glyph: "\uD83D\uDD04",
    },
    {
      action: "dismiss",
      testId: "twh-dismiss",
      label: "Dismiss",
      glyph: "\uD83D\uDC4E",
    },
    {
      action: "expand",
      testId: "twh-expand",
      label: "Expand to card",
      glyph: "\u21F1",
    },
  ];

  for (const a of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = a.primary ? "twh-action twh-primary" : "twh-action";
    btn.dataset["action"] = a.action;
    btn.dataset["testid"] = a.testId;
    btn.setAttribute("aria-label", a.label);
    btn.title = a.label;
    btn.textContent = a.glyph;
    // Click listener is attached in `mountDock()` (not here) because the
    // handler closes over the resolved tweet_id + port + suggested_reply,
    // which are mount-time state rather than element-construction state.
    root.appendChild(btn);
  }

  ensureFallbackStyles();
  return root;
}

/**
 * Fallback style injection.
 *
 * Production ships via manifest `content_scripts[].css`, which runs
 * before the content JS and is CSP-safe. Injecting these rules here as
 * well guarantees the Dock is styled even if the CSS asset is absent
 * (e.g. someone bypasses the build pipeline, or a test loads the JS
 * directly). Duplicate rules with the manifest CSS are deliberate —
 * browsers merge them by specificity and the result is identical.
 */
function ensureFallbackStyles(): void {
  if (document.getElementById("twh-dock-fallback-styles") !== null) return;
  const style = document.createElement("style");
  style.id = "twh-dock-fallback-styles";
  style.textContent = FALLBACK_CSS;
  document.head.appendChild(style);
}

/**
 * CSS kept in sync with src/content.css. The manifest CSS is the
 * production source of truth; this copy exists so the tests still pass
 * if someone runs the extension with the JS-only build, and so the
 * Dock has a baseline appearance from the moment JS parses.
 */
const FALLBACK_CSS = `
#twh-dock {
  position: fixed;
  z-index: 2147483600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: #15202b;
  color: #f7f9f9;
  border: 1px solid #38444d;
  border-radius: 999px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.28);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  user-select: none;
}
#twh-dock.twh-dock-default {
  top: ${DEFAULT_OFFSET_TOP}px;
  right: ${DEFAULT_OFFSET_RIGHT}px;
}
#twh-dock .twh-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 28px;
  padding: 0 4px;
  font-size: 14px;
  color: #8899a6;
  cursor: grab;
  letter-spacing: -1px;
}
#twh-dock .twh-handle:active {
  cursor: grabbing;
}
#twh-dock button.twh-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  margin: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
#twh-dock button.twh-action:hover {
  background: rgba(239, 243, 244, 0.10);
}
#twh-dock button.twh-action.twh-primary {
  background: #1d9bf0;
  color: #fff;
  box-shadow: inset 0 -2px 0 rgba(0,0,0,0.18);
}
#twh-dock button.twh-action.twh-primary:hover {
  background: #1a8cd8;
}
`;
