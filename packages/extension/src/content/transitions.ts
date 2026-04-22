/**
 * Dock ↔ Card transition controller (CP07).
 *
 * Owns a single `WidgetStateMachine` instance and orchestrates the DOM
 * swap between `dock.ts` and `card.ts` in response to ⇱ (expand) and
 * ⇲ (collapse) clicks.
 *
 * Why a controller object instead of module-level singletons?
 *   `content-script.ts` may re-run on SPA navigation; we need the
 *   controller to live exactly as long as one (tweetId, suggestion)
 *   pair. A fresh controller per navigation keeps state local and
 *   avoids cross-tweet leaks without manual `reset()` calls.
 *
 * Animation contract:
 *   - Both shapes animate via CSS transitions on `opacity` +
 *     `transform: scale()`, duration 180 ms (well under the spec's
 *     250 ms ceiling).
 *   - Each expand/collapse follows:
 *       1. mount the new shape with the `.twh-enter` class (invisible,
 *          scaled to 0.95) at the outgoing shape's current anchor;
 *       2. unmount the outgoing shape;
 *       3. requestAnimationFrame → swap to `.twh-enter-active`, which
 *          transitions to opacity 1 + scale 1;
 *       4. await `transitionend` (or a 300 ms fallback timeout) →
 *          machine's finishExpand() / finishCollapse() resolves.
 *   - The fallback timeout is critical: if the element is detached mid-
 *     animation (e.g. the user navigates away), `transitionend` never
 *     fires and the machine would otherwise get stuck in `expanding`.
 */
import {
  WidgetStateMachine,
  type WidgetState,
} from "./widget-state.js";
import {
  DOCK_ID,
  mountDock,
  unmountDock,
  type DockOptions,
} from "./dock.js";
import {
  CARD_ID,
  mountCard,
  unmountCard,
  type CardCandidateView,
} from "./card.js";
import {
  type LocalStorageLike,
  type WidgetPosition,
} from "./position-store.js";

/** Maximum time to wait for a `transitionend` before force-finishing. */
const TRANSITION_FALLBACK_MS = 300;
/** Animation-start class → removed after one rAF. */
const ENTER_CLASS = "twh-enter";
/** Animation-target class → applied on the second rAF. */
const ENTER_ACTIVE_CLASS = "twh-enter-active";

export interface WidgetControllerOptions {
  tweetId: string;
  suggestionPayload: unknown;
  candidate: CardCandidateView;
  port?: number | null;
  storage?: LocalStorageLike;
}

export interface WidgetController {
  /** Initial mount — renders the Dock, primed for expand/collapse. */
  start(): Promise<void>;
  /** Tear down the widget (called from SPA-navigation unmount). */
  dispose(): void;
  /** Inspect the current state for test purposes. */
  currentState(): WidgetState;
}

/**
 * Factory for a Dock/Card controller bound to a single tweet id.
 * Callers keep the returned handle for the duration of the route and
 * call `dispose()` on SPA navigation away.
 */
export function createWidgetController(
  options: WidgetControllerOptions,
): WidgetController {
  const port = options.port ?? null;
  const storage = options.storage;

  const machine = new WidgetStateMachine(onStateChange);
  let disposed = false;

  // --- Event wiring ------------------------------------------------------
  // ⇱ click on the Dock → request expand. Rejected if not resting.
  const requestExpand = (): void => {
    machine.requestExpand();
  };
  // ⇲ click on the Card → request collapse. Rejected if not resting.
  const requestCollapse = (): void => {
    machine.requestCollapse();
  };
  // Dismiss from either widget → terminal teardown, skip the state
  // machine (the widget is gone; there is nothing to animate).
  const onDismiss = (): void => {
    disposed = true;
    unmountCard();
    unmountDock();
  };

  async function start(): Promise<void> {
    const dockOptions: DockOptions = {
      tweetId: options.tweetId,
      suggestionPayload: options.suggestionPayload,
      port,
      ...(storage !== undefined ? { storage } : {}),
      onExpand: requestExpand,
      onDismiss,
    };
    await mountDock(dockOptions);
  }

  async function onStateChange(next: WidgetState): Promise<void> {
    if (disposed) return;

    if (next === "expanding") {
      // Capture the Dock's current top-left so the Card mounts at the
      // same anchor. If no Dock is mounted (defensive — machine would
      // have rejected the request), fall back to undefined so the Card
      // uses its own persisted/default anchor.
      const dockAnchor = readWidgetAnchor(DOCK_ID);

      await mountCard({
        tweetId: options.tweetId,
        candidate: options.candidate,
        port,
        ...(storage !== undefined ? { storage } : {}),
        ...(dockAnchor !== null ? { anchor: dockAnchor } : {}),
        onCollapse: requestCollapse,
        onDismiss,
      });

      // Dock is replaced by the Card — no cross-fade, just swap to keep
      // the "both states visible simultaneously" assertion trivial.
      unmountDock();

      const card = document.getElementById(CARD_ID);
      if (card === null) {
        // Mount failed unexpectedly; force-finish so the machine
        // doesn't get stuck.
        machine.finishExpand();
        return;
      }
      animateEnter(card, () => {
        if (!disposed) machine.finishExpand();
      });
    } else if (next === "collapsing") {
      const cardAnchor = readWidgetAnchor(CARD_ID);

      const dockOptions: DockOptions = {
        tweetId: options.tweetId,
        suggestionPayload: options.suggestionPayload,
        port,
        ...(storage !== undefined ? { storage } : {}),
        ...(cardAnchor !== null ? { anchor: cardAnchor } : {}),
        onExpand: requestExpand,
        onDismiss,
      };
      await mountDock(dockOptions);
      unmountCard();

      const dock = document.getElementById(DOCK_ID);
      if (dock === null) {
        machine.finishCollapse();
        return;
      }
      animateEnter(dock, () => {
        if (!disposed) machine.finishCollapse();
      });
    }
    // 'card' and 'dock' resting states need no DOM work here — the
    // animation helper already applied the final class.
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unmountCard();
    unmountDock();
  }

  function currentState(): WidgetState {
    return machine.current();
  }

  return { start, dispose, currentState };
}

/**
 * Kick a mounted element through its `.twh-enter` → `.twh-enter-active`
 * transition, then invoke `onDone` once `transitionend` fires (or the
 * fallback timeout lapses, whichever happens first). The listeners are
 * removed before `onDone` so the machine is only poked once.
 */
function animateEnter(el: HTMLElement, onDone: () => void): void {
  el.classList.add(ENTER_CLASS);

  // Double rAF: the first paint flushes the `.twh-enter` styles, the
  // second swaps to `.twh-enter-active` so the transition actually
  // animates instead of skipping straight to the final state.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.remove(ENTER_CLASS);
      el.classList.add(ENTER_ACTIVE_CLASS);
    });
  });

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    el.removeEventListener("transitionend", onTransitionEnd);
    clearTimeout(fallbackTimer);
    // Drop the active class so future state changes start from a clean
    // slate. If the element was already unmounted, this is a harmless
    // property set on a detached node.
    el.classList.remove(ENTER_ACTIVE_CLASS);
    onDone();
  };
  const onTransitionEnd = (event: TransitionEvent): void => {
    // Only react to transitions on the element itself. A child node
    // (e.g. a button) also fires transitionend on hover in some
    // browsers — ignore those.
    if (event.target !== el) return;
    finish();
  };
  el.addEventListener("transitionend", onTransitionEnd);

  const fallbackTimer = setTimeout(finish, TRANSITION_FALLBACK_MS);
}

/**
 * Read the current top-left of a mounted widget as {x, y}. Returns
 * `null` if the element is not in the DOM. Used to anchor the incoming
 * shape at the outgoing shape's position.
 */
function readWidgetAnchor(id: string): WidgetPosition | null {
  const el = document.getElementById(id);
  if (el === null) return null;
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
}
