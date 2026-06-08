import { attachDrag, applyPosition } from "./drag.js";
import { loadPosition, savePosition, clampToViewport, type LocalStorageLike, type WidgetPosition, } from "./position-store.js";
import { handleAction, type DockAction } from "./actions.js";
import { clearToast } from "./toast.js";
export const CARD_ID = "twh-card";
const CARD_DEFAULT_OFFSET_RIGHT = 16;
const CARD_DEFAULT_OFFSET_TOP = 96;
export interface CardCandidateView {
    matchReason: string;
    suggestedReply: string;
}
export interface CardOptions {
    tweetId: string;
    candidate: CardCandidateView;
    port?: number | null;
    storage?: LocalStorageLike;
    onCollapse: () => void;
    onDismiss: () => void;
    anchor?: WidgetPosition;
}
let detachCardDrag: (() => void) | null = null;
let mountedCardTweetId: string | null = null;
export async function mountCard(options: CardOptions): Promise<HTMLElement | null> {
    if (mountedCardTweetId === options.tweetId &&
        document.getElementById(CARD_ID) !== null) {
        return document.getElementById(CARD_ID);
    }
    unmountCard();
    const root = buildCardElement(options);
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
    const handle = root.querySelector<HTMLElement>('[data-testid="twh-card-drag-handle"]');
    if (handle !== null) {
        detachCardDrag = attachDrag({
            target: root,
            handle,
            onDrop: (pos: WidgetPosition) => {
                void savePosition(pos, { storage: options.storage });
            },
        });
    }
    const port = options.port ?? null;
    const actionButtons = root.querySelectorAll<HTMLButtonElement>("button.twh-card-action");
    for (const btn of actionButtons) {
        const raw = btn.dataset["action"];
        if (raw === undefined)
            continue;
        const action = raw as DockAction;
        btn.addEventListener("click", () => {
            void handleAction(action, {
                tweetId: options.tweetId,
                suggestedReply: options.candidate.suggestedReply,
                port,
                onDismiss: options.onDismiss,
                onCollapse: options.onCollapse,
            });
        });
    }
    mountedCardTweetId = options.tweetId;
    return root;
}
export function unmountCard(): void {
    if (detachCardDrag !== null) {
        detachCardDrag();
        detachCardDrag = null;
    }
    mountedCardTweetId = null;
    document.getElementById(CARD_ID)?.remove();
    clearToast();
}
function buildCardElement(options: CardOptions): HTMLElement {
    const root = document.createElement("div");
    root.id = CARD_ID;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Wingman-X Card");
    root.classList.add("twh-card-default");
    root.dataset["tweetId"] = options.tweetId;
    const header = document.createElement("header");
    header.className = "twh-card-header";
    header.dataset["testid"] = "twh-card-header";
    header.dataset["testid"] = "twh-card-drag-handle";
    header.setAttribute("aria-label", "Drag Wingman-X Card");
    const grip = document.createElement("span");
    grip.className = "twh-card-grip";
    grip.textContent = "\u22EE\u22EE";
    grip.setAttribute("aria-hidden", "true");
    header.appendChild(grip);
    const title = document.createElement("span");
    title.className = "twh-card-title";
    title.textContent = "Wingman-X";
    header.appendChild(title);
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "twh-card-action twh-card-collapse";
    collapseBtn.dataset["action"] = "collapse";
    collapseBtn.dataset["testid"] = "twh-card-collapse";
    collapseBtn.setAttribute("aria-label", "Collapse to dock");
    collapseBtn.title = "Collapse to dock";
    collapseBtn.textContent = "\u21F2";
    collapseBtn.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
    });
    header.appendChild(collapseBtn);
    root.appendChild(header);
    const body = document.createElement("section");
    body.className = "twh-card-body";
    const matchReason = document.createElement("div");
    matchReason.className = "twh-card-match-reason";
    matchReason.dataset["testid"] = "twh-card-match-reason";
    matchReason.textContent = options.candidate.matchReason;
    body.appendChild(matchReason);
    const replyPreview = document.createElement("div");
    replyPreview.className = "twh-card-reply-preview";
    replyPreview.dataset["testid"] = "twh-card-reply-preview";
    replyPreview.textContent = options.candidate.suggestedReply;
    body.appendChild(replyPreview);
    root.appendChild(body);
    const footer = document.createElement("footer");
    footer.className = "twh-card-actions";
    const actions: ReadonlyArray<{
        action: string;
        testId: string;
        label: string;
        glyph: string;
        primary?: boolean;
    }> = [
        {
            action: "fill",
            testId: "twh-card-fill",
            label: "Fill reply",
            glyph: "\u270D\uFE0F",
            primary: true,
        },
        {
            action: "quote",
            testId: "twh-card-quote",
            label: "Quote reply",
            glyph: "\uD83D\uDCAC",
        },
        {
            action: "save",
            testId: "twh-card-save",
            label: "Save for later",
            glyph: "\uD83D\uDD16",
        },
        {
            action: "regen",
            testId: "twh-card-regen",
            label: "Regenerate",
            glyph: "\uD83D\uDD04",
        },
        {
            action: "dismiss",
            testId: "twh-card-dismiss",
            label: "Dismiss",
            glyph: "\uD83D\uDC4E",
        },
    ];
    for (const a of actions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = a.primary
            ? "twh-card-action twh-card-primary"
            : "twh-card-action";
        btn.dataset["action"] = a.action;
        btn.dataset["testid"] = a.testId;
        btn.setAttribute("aria-label", a.label);
        btn.title = a.label;
        btn.textContent = a.glyph;
        footer.appendChild(btn);
    }
    root.appendChild(footer);
    ensureCardFallbackStyles();
    return root;
}
function ensureCardFallbackStyles(): void {
    if (document.getElementById("twh-card-fallback-styles") !== null)
        return;
    const style = document.createElement("style");
    style.id = "twh-card-fallback-styles";
    style.textContent = CARD_FALLBACK_CSS;
    document.head.appendChild(style);
}
const CARD_FALLBACK_CSS = `
#twh-card {
  position: fixed;
  z-index: 2147483600;
  width: 320px;
  max-width: calc(100vw - 32px);
  background: #15202b;
  color: #f7f9f9;
  border: 1px solid #38444d;
  border-radius: 14px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.36);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  transition: opacity 180ms ease, transform 180ms ease;
  user-select: none;
}
#twh-card.twh-card-default {
  top: ${CARD_DEFAULT_OFFSET_TOP}px;
  right: ${CARD_DEFAULT_OFFSET_RIGHT}px;
}
#twh-card .twh-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #253341;
  cursor: grab;
}
#twh-card .twh-card-header:active {
  cursor: grabbing;
}
#twh-card .twh-card-grip {
  color: #8899a6;
  letter-spacing: -1px;
  font-size: 14px;
}
#twh-card .twh-card-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: #e7e9ea;
}
#twh-card .twh-card-body {
  padding: 10px 12px 12px;
  user-select: text;
  cursor: default;
}
#twh-card .twh-card-match-reason {
  font-size: 12px;
  color: #8899a6;
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#twh-card .twh-card-reply-preview {
  font-size: 14px;
  line-height: 1.45;
  color: #f7f9f9;
  white-space: pre-wrap;
  word-break: break-word;
}
#twh-card .twh-card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-top: 1px solid #253341;
}
#twh-card button.twh-card-action {
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
#twh-card button.twh-card-action:hover {
  background: rgba(239, 243, 244, 0.10);
}
#twh-card button.twh-card-primary {
  background: #1d9bf0;
  color: #fff;
  box-shadow: inset 0 -2px 0 rgba(0,0,0,0.18);
}
#twh-card button.twh-card-primary:hover {
  background: #1a8cd8;
}
#twh-card button.twh-card-collapse {
  margin-left: auto;
  background: transparent;
}
#twh-card.twh-enter {
  opacity: 0;
  transform: scale(0.95);
}
#twh-card.twh-enter-active {
  opacity: 1;
  transform: scale(1);
}
#twh-card.twh-exit {
  opacity: 1;
  transform: scale(1);
}
#twh-card.twh-exit-active {
  opacity: 0;
  transform: scale(0.95);
}
`;
