/**
 * Candidate card renderer for the popup.
 *
 * Per-card layout (from CP08 technical guidance):
 *   <article data-testid="twh-popup-card" data-id="<tweet_id>">
 *     <header>@handle</header>
 *     <div class="twh-tweet-preview">tweet text (≤ 80 chars)</div>
 *     <div class="twh-reply-preview">reply text (≤ 80 chars)</div>
 *     <footer>
 *       <button data-testid="twh-popup-open">Open</button>
 *       <button data-testid="twh-popup-dismiss" aria-label="Dismiss">×</button>
 *     </footer>
 *   </article>
 *
 * Handlers for the two buttons are passed as callbacks — this keeps the
 * card module pure DOM-building + focused on presentation. The popup
 * wires the daemon calls.
 */
import type { PopupCandidate } from "./daemon-client.js";
import { truncate } from "./truncate.js";

export const PREVIEW_MAX = 80;

export interface CardHandlers {
  onOpen: (candidate: PopupCandidate) => void;
  onDismiss: (candidate: PopupCandidate) => void;
}

/**
 * Build a detached `<article>` element for a single candidate. The
 * caller appends it to the list container.
 */
export function renderCard(
  candidate: PopupCandidate,
  handlers: CardHandlers,
): HTMLElement {
  const article = document.createElement("article");
  article.className = "twh-popup-card";
  article.dataset.testid = "twh-popup-card";
  // Expose the tweet id so E2E can target a specific card directly.
  article.dataset.id = candidate.tweet_id;
  // Also expose via the `data-testid` attribute Playwright expects —
  // `dataset.testid` emits `data-testid`, but we spell it explicitly
  // here for grep-ability and to document intent.
  article.setAttribute("data-testid", "twh-popup-card");

  const header = document.createElement("header");
  header.className = "twh-card-header";
  const handle = document.createElement("span");
  handle.className = "twh-author";
  handle.textContent = candidate.author_handle;
  header.append(handle);

  const tweetPreview = document.createElement("div");
  tweetPreview.className = "twh-tweet-preview";
  tweetPreview.textContent = truncate(candidate.tweet_text, PREVIEW_MAX);

  const replyPreview = document.createElement("div");
  replyPreview.className = "twh-reply-preview";
  replyPreview.textContent = truncate(candidate.suggested_reply, PREVIEW_MAX);
  // CP03: when the agent flagged AI-tell terms in the reply, append a ⚠️
  // marker with the matched terms in title/aria-label. A candidate WITHOUT
  // flags renders nothing extra (no layout shift for the common case).
  const aiTellFlags = candidate.ai_tell_flags;
  if (aiTellFlags !== undefined && aiTellFlags.length > 0) {
    const warn = document.createElement("span");
    warn.className = "twh-ai-tell";
    warn.setAttribute("data-testid", "twh-popup-ai-tell");
    warn.textContent = "⚠️"; // ⚠️
    const terms = `AI tell: ${aiTellFlags.join(", ")}`;
    warn.title = terms;
    warn.setAttribute("aria-label", terms);
    replyPreview.append(" ", warn);
  }

  const footer = document.createElement("footer");
  footer.className = "twh-card-buttons";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "twh-open";
  openBtn.textContent = "Open";
  openBtn.setAttribute("data-testid", "twh-popup-open");
  openBtn.addEventListener("click", () => handlers.onOpen(candidate));

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "twh-dismiss";
  dismissBtn.textContent = "\u00d7"; // ×
  dismissBtn.setAttribute("aria-label", "Dismiss");
  dismissBtn.setAttribute("data-testid", "twh-popup-dismiss");
  dismissBtn.addEventListener("click", () => handlers.onDismiss(candidate));

  footer.append(openBtn, dismissBtn);
  article.append(header, tweetPreview, replyPreview, footer);
  return article;
}
