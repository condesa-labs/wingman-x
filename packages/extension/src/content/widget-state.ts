/**
 * Widget state machine (CP07).
 *
 * Models the four states the Dock/Card widget cycles through:
 *
 *     dock → expanding → card → collapsing → dock
 *
 * The machine is the ONLY source of truth for which shape is visible.
 * The caller (`transitions.ts`) mounts/unmounts DOM in response to
 * `onChange` and drives the machine through `requestExpand /
 * finishExpand / requestCollapse / finishCollapse`.
 *
 * Why four states?
 *   A boolean "isAnimating" would not distinguish "animating toward
 *   card" from "animating toward dock" — mashing ⇱/⇲ mid-animation
 *   could then dispatch a conflicting transition, leaving the DOM with
 *   both widgets mounted. The four-state model rejects any request from
 *   a non-resting state, so the caller can safely defer DOM swaps until
 *   the animation completes (or the fallback timeout fires).
 *
 * Contract:
 *   - `requestExpand()` only succeeds from `dock`. Returns `true` if
 *     accepted, `false` if the current state is already `expanding`,
 *     `card`, or `collapsing`. On accept, fires `onChange('expanding')`.
 *   - `finishExpand()` only fires from `expanding` → `card`. Other
 *     states: no-op, no callback fire.
 *   - `requestCollapse()` only succeeds from `card`. Mid-expand
 *     `requestCollapse` is rejected — the lock the spec relies on.
 *   - `finishCollapse()` only fires from `collapsing` → `dock`.
 *   - `onChange` fires exactly once per accepted transition, with the
 *     new state as argument. Never fires on rejected transitions.
 */

export type WidgetState = "dock" | "expanding" | "card" | "collapsing";

export class WidgetStateMachine {
  private state: WidgetState = "dock";
  private readonly onChange: (s: WidgetState) => void;

  constructor(onChange: (s: WidgetState) => void) {
    this.onChange = onChange;
  }

  /** Current state — used by the caller to decide if DOM work is safe. */
  current(): WidgetState {
    return this.state;
  }

  /**
   * Attempt to transition dock → expanding. Returns `true` iff accepted.
   * Rejected from any non-resting state so the caller never double-
   * mounts the Card during an in-flight animation.
   */
  requestExpand(): boolean {
    if (this.state !== "dock") return false;
    this.state = "expanding";
    this.onChange(this.state);
    return true;
  }

  /**
   * Complete a pending expand: expanding → card. Called by the caller
   * on `transitionend` OR the safety timeout. No-op from other states so
   * a spurious `transitionend` (event bubbling from a child element, etc.)
   * cannot corrupt state.
   */
  finishExpand(): void {
    if (this.state !== "expanding") return;
    this.state = "card";
    this.onChange(this.state);
  }

  /**
   * Attempt to transition card → collapsing. Returns `true` iff accepted.
   * Rejected from `dock` (nothing to collapse), `expanding` (can't flip
   * mid-animation), or `collapsing` (already under way). The mid-expand
   * rejection is the primary "mashing" lock.
   */
  requestCollapse(): boolean {
    if (this.state !== "card") return false;
    this.state = "collapsing";
    this.onChange(this.state);
    return true;
  }

  /**
   * Complete a pending collapse: collapsing → dock. No-op from other
   * states (same reason as `finishExpand`).
   */
  finishCollapse(): void {
    if (this.state !== "collapsing") return;
    this.state = "dock";
    this.onChange(this.state);
  }
}
