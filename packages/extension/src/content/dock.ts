import { attachDrag, applyPosition } from "./drag.js";
import { loadPosition, savePosition, clampToViewport, type LocalStorageLike, type WidgetPosition, } from "./position-store.js";
import { handleAction, type DockAction } from "./actions.js";
import { clearToast } from "./toast.js";
export const DOCK_ID = "twh-dock";
const DEFAULT_OFFSET_RIGHT = 16;
const DEFAULT_OFFSET_TOP = 96;
export interface DockOptions {
    tweetId: string;
    suggestionPayload: unknown;
    port?: number | null;
    storage?: LocalStorageLike;
    onExpand?: () => void;
    onDismiss?: () => void;
    anchor?: WidgetPosition;
}
let detachDrag: (() => void) | null = null;
let mountedTweetId: string | null = null;
export async function mountDock(options: DockOptions): Promise<HTMLElement | null> {
    if (mountedTweetId === options.tweetId &&
        document.getElementById(DOCK_ID) !== null) {
        return document.getElementById(DOCK_ID);
    }
    unmountDock();
    const root = buildDockElement(options);
    document.body.appendChild(root);
    let positionToApply: WidgetPosition | null = options.anchor ?? null;
    if (positionToApply === null) {
        positionToApply = await loadPosition({ storage: options.storage });
    }
    if (positionToApply !== null) {
        const rect = root.getBoundingClientRect();
        const clamped = clampToViewport(positionToApply, {
            width: window.innerWidth,
            height: window.innerHeight,
            dockWidth: rect.width,
            dockHeight: rect.height,
        });
        applyPosition(root, clamped);
    }
    const handle = root.querySelector<HTMLElement>('[data-testid="twh-drag-handle"]');
    if (handle !== null) {
        detachDrag = attachDrag({
            target: root,
            handle,
            onDrop: (pos: WidgetPosition) => {
                void savePosition(pos, { storage: options.storage });
            },
        });
    }
    const suggestedReply = extractSuggestedReply(options.suggestionPayload);
    const port = options.port ?? null;
    const actionButtons = root.querySelectorAll<HTMLButtonElement>("button.twh-action");
    for (const btn of actionButtons) {
        const raw = btn.dataset["action"];
        if (raw === undefined)
            continue;
        const action = raw as DockAction;
        btn.addEventListener("click", () => {
            void handleAction(action, {
                tweetId: options.tweetId,
                suggestedReply,
                port,
                ...(options.onExpand !== undefined
                    ? { onExpand: options.onExpand }
                    : {}),
                ...(options.onDismiss !== undefined
                    ? { onDismiss: options.onDismiss }
                    : {}),
            });
        });
    }
    mountedTweetId = options.tweetId;
    return root;
}
export function unmountDock(): void {
    if (detachDrag !== null) {
        detachDrag();
        detachDrag = null;
    }
    mountedTweetId = null;
    document.getElementById(DOCK_ID)?.remove();
    clearToast();
}
function extractSuggestedReply(payload: unknown): string {
    if (payload !== null &&
        typeof payload === "object" &&
        "suggested_reply" in payload &&
        typeof (payload as {
            suggested_reply: unknown;
        }).suggested_reply === "string") {
        return (payload as {
            suggested_reply: string;
        }).suggested_reply;
    }
    return "";
}
function buildDockElement(options: DockOptions): HTMLElement {
    const root = document.createElement("div");
    root.id = DOCK_ID;
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "Wingman-X Dock");
    root.classList.add("twh-dock-default");
    try {
        root.dataset["suggestion"] = JSON.stringify(options.suggestionPayload);
    }
    catch {
    }
    const handle = document.createElement("span");
    handle.className = "twh-handle";
    handle.dataset["testid"] = "twh-drag-handle";
    handle.setAttribute("aria-label", "Drag Wingman-X Dock");
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
        root.appendChild(btn);
    }
    ensureFallbackStyles();
    return root;
}
function ensureFallbackStyles(): void {
    if (document.getElementById("twh-dock-fallback-styles") !== null)
        return;
    const style = document.createElement("style");
    style.id = "twh-dock-fallback-styles";
    style.textContent = FALLBACK_CSS;
    document.head.appendChild(style);
}
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
#twh-dock {
  transition: opacity 180ms ease, transform 180ms ease;
}
#twh-dock.twh-enter {
  opacity: 0;
  transform: scale(0.95);
}
#twh-dock.twh-enter-active {
  opacity: 1;
  transform: scale(1);
}
`;
