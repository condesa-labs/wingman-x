/**
 * Floating toast (CP06).
 *
 * Single-slot model: calling `showToast()` replaces any active toast
 * rather than stacking them. This keeps the implementation tiny and
 * matches the MVP semantics — CP06 only calls it from three distinct
 * actions (regen, quote stub, save stub), none of which benefit from a
 * queue.
 *
 * Design notes:
 *   - `position: fixed; z-index: 2147483647;` to stack above twitter.com's
 *     layered UI without co-operating with its z-index stacking context.
 *   - `role="status"` + `aria-live="polite"` so screen-readers announce
 *     the message without stealing focus.
 *   - CSS transitions for fade-in / fade-out (no JS animation frames).
 *   - Self-teardown after `durationMs` via setTimeout. An in-flight
 *     timer is cleared before a new toast mounts to avoid the previous
 *     timer dismissing the new message early.
 */

export const TOAST_ID = "twh-toast";
const DEFAULT_DURATION_MS = 2_500;
const FADE_MS = 180;

/** Timer id for the active toast's auto-dismiss. */
let activeTimer: ReturnType<typeof setTimeout> | null = null;
/** Timer id for the active toast's post-fade removal. */
let removalTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Show a toast with `message`. Replaces any existing toast. Returns the
 * mounted element so tests can poke at it if needed.
 */
export function showToast(
  message: string,
  durationMs: number = DEFAULT_DURATION_MS,
): HTMLElement {
  ensureToastFallbackStyles();

  // Replace any existing toast so successive clicks don't stack.
  if (activeTimer !== null) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  if (removalTimer !== null) {
    clearTimeout(removalTimer);
    removalTimer = null;
  }
  document.getElementById(TOAST_ID)?.remove();

  const toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.dataset["testid"] = "twh-toast";
  toast.textContent = message;
  // Start transparent; flip to visible on the next paint so the
  // transition registers. Otherwise the first paint would already be at
  // opacity: 1 with no fade-in.
  toast.classList.add("twh-toast-hidden");
  document.body.appendChild(toast);

  // `requestAnimationFrame` → let the browser commit the hidden state,
  // then toggle to visible so the transition runs.
  requestAnimationFrame(() => {
    toast.classList.remove("twh-toast-hidden");
    toast.classList.add("twh-toast-visible");
  });

  activeTimer = setTimeout(() => {
    toast.classList.remove("twh-toast-visible");
    toast.classList.add("twh-toast-hidden");
    removalTimer = setTimeout(() => {
      toast.remove();
      removalTimer = null;
    }, FADE_MS);
    activeTimer = null;
  }, durationMs);

  return toast;
}

/**
 * Test helper: immediately remove any active toast. Used by unmount
 * paths (e.g. dismiss) so a lingering toast doesn't obscure the next
 * navigation's UI.
 */
export function clearToast(): void {
  if (activeTimer !== null) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  if (removalTimer !== null) {
    clearTimeout(removalTimer);
    removalTimer = null;
  }
  document.getElementById(TOAST_ID)?.remove();
}

/**
 * Fallback style injection. Analogous to `dock.ts`'s pattern — the
 * production path ships these rules via manifest CSS, but injecting
 * them here guarantees the toast is styled even when the content-script
 * JS is loaded without its companion stylesheet.
 */
function ensureToastFallbackStyles(): void {
  if (document.getElementById("twh-toast-fallback-styles") !== null) return;
  const style = document.createElement("style");
  style.id = "twh-toast-fallback-styles";
  style.textContent = TOAST_FALLBACK_CSS;
  document.head.appendChild(style);
}

const TOAST_FALLBACK_CSS = `
#twh-toast {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  max-width: 320px;
  padding: 10px 14px;
  background: #15202b;
  color: #f7f9f9;
  border: 1px solid #38444d;
  border-radius: 12px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.28);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.4;
  transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease;
  pointer-events: none;
}
#twh-toast.twh-toast-hidden {
  opacity: 0;
  transform: translateY(8px);
}
#twh-toast.twh-toast-visible {
  opacity: 1;
  transform: translateY(0);
}
`;
