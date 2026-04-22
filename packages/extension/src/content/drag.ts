/**
 * Drag behaviour for the CP05 Dock widget.
 *
 * Attaches a pointerdown listener to a drag handle, and on pointermove
 * moves the target element via `left`/`top` inline styles. Uses
 * `setPointerCapture` so the drag survives the pointer leaving the handle
 * (common when moving quickly). Invokes `onDrop` with the final {x, y}
 * so the caller can persist the position.
 *
 * Design notes:
 *   - Pointer events (not mouse) so touch + stylus "just work".
 *   - We clamp the current position against the viewport on every
 *     pointermove to prevent the Dock from leaving the screen mid-drag.
 *     Persistence uses the same clamp on load so the saved position can
 *     never be restored off-screen either.
 *   - No network calls here — CP05 is Dock-render-only. This module
 *     stays DOM-only so CP06 can layer its action handlers on top
 *     without re-architecting the drag path.
 */
import {
  clampToViewport,
  type WidgetPosition,
} from "./position-store.js";

export interface DragOptions {
  /** The element that moves as a unit (the whole Dock). */
  target: HTMLElement;
  /** The drag grip — only pointerdown on this element starts a drag. */
  handle: HTMLElement;
  /** Called after a successful drag, with the Dock's top-left position. */
  onDrop: (pos: WidgetPosition) => void;
}

/**
 * Wire a pointer-driven drag from `handle` → `target` and invoke
 * `onDrop(pos)` when the user releases the pointer. Returns a teardown
 * function that removes the listener (used by the content-script when
 * unmounting the Dock on SPA navigation).
 */
export function attachDrag(options: DragOptions): () => void {
  const { target, handle, onDrop } = options;

  /** Offset of the pointer from the Dock's top-left at drag-start. */
  let pointerOffsetX = 0;
  let pointerOffsetY = 0;
  /** Live pointer id so we release capture at pointerup. */
  let activePointerId: number | null = null;

  function onPointerDown(event: PointerEvent): void {
    // Only the primary button (left-click / single touch) initiates drag.
    if (event.button !== 0) return;

    const rect = target.getBoundingClientRect();
    pointerOffsetX = event.clientX - rect.left;
    pointerOffsetY = event.clientY - rect.top;
    activePointerId = event.pointerId;

    // setPointerCapture keeps pointermove events coming to this handle
    // even if the pointer leaves the element (e.g. drag too fast).
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Not all environments support pointer capture — fall back to
      // window-level listeners below, which work unconditionally.
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (activePointerId !== null && event.pointerId !== activePointerId) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const clamped = clampToViewport(
      {
        x: event.clientX - pointerOffsetX,
        y: event.clientY - pointerOffsetY,
      },
      {
        width: window.innerWidth,
        height: window.innerHeight,
        dockWidth: rect.width,
        dockHeight: rect.height,
      },
    );
    applyPosition(target, clamped);
  }

  function onPointerUp(event: PointerEvent): void {
    if (activePointerId !== null && event.pointerId !== activePointerId) {
      return;
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      // ignore — capture was never acquired.
    }
    activePointerId = null;

    const rect = target.getBoundingClientRect();
    onDrop({ x: rect.left, y: rect.top });
  }

  handle.addEventListener("pointerdown", onPointerDown);

  return (): void => {
    handle.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  };
}

/**
 * Apply a position to a Dock element. Uses `left`/`top` + `right: auto`
 * so dragging overrides the right-edge default. Rounded to integer px so
 * the DOM and the saved position agree to the pixel.
 */
export function applyPosition(
  target: HTMLElement,
  pos: WidgetPosition,
): void {
  target.style.left = `${Math.round(pos.x)}px`;
  target.style.top = `${Math.round(pos.y)}px`;
  target.style.right = "auto";
  target.style.bottom = "auto";
}
