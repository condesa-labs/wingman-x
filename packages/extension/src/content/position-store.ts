/**
 * Position persistence for the CP05 Dock widget.
 *
 * Scope: load / save / clamp helpers around `chrome.storage.local` under
 * the documented key `widget_position`. The shape is the absolute
 * top-left of the Dock in viewport px: `{ x: number, y: number }`.
 *
 * Why a separate module?
 *   The Dock renderer (`dock.ts`) and the drag handler (`drag.ts`) both
 *   need to touch storage and both need the clamping routine. Extracting
 *   the logic here keeps each of those files focused on DOM concerns and
 *   makes the storage contract unit-testable without a real `chrome`
 *   runtime (see `test/unit/position-store.test.ts`).
 *
 * Why integer px?
 *   Rounding on save eliminates float-drift across successive drag
 *   sessions. The spec allows 1 px tolerance; we pick a strict 0 px
 *   policy so the tolerance is true headroom, not baseline noise.
 */

export const STORAGE_KEY = "widget_position";

export interface WidgetPosition {
  x: number;
  y: number;
}

/**
 * Minimal shape of `chrome.storage.local` we depend on. Lets us unit-test
 * without a real Chrome runtime and mirrors the pattern used by
 * `port-discovery.ts` for session storage.
 */
export interface LocalStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface StorageOptions {
  storage?: LocalStorageLike;
}

/** Default adapter that reads `chrome.storage.local`. */
export function defaultStorage(): LocalStorageLike {
  return {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
    remove: (key) => chrome.storage.local.remove(key),
  };
}

/**
 * Persist the Dock's top-left position. Values are rounded to integer px
 * so round-trips do not accumulate float error.
 */
export async function savePosition(
  pos: WidgetPosition,
  options: StorageOptions = {},
): Promise<void> {
  const storage = options.storage ?? defaultStorage();
  const rounded: WidgetPosition = {
    x: Math.round(pos.x),
    y: Math.round(pos.y),
  };
  await storage.set({ [STORAGE_KEY]: rounded });
}

/**
 * Read the persisted position, or `null` if nothing is stored or the
 * stored value is malformed. Malformed values are treated as "no
 * persisted position" rather than surfaced as errors, so corrupted
 * storage state cannot crash the Dock mount path.
 */
export async function loadPosition(
  options: StorageOptions = {},
): Promise<WidgetPosition | null> {
  const storage = options.storage ?? defaultStorage();
  const entry = await storage.get(STORAGE_KEY);
  const raw = entry[STORAGE_KEY];
  if (
    raw === null ||
    typeof raw !== "object" ||
    typeof (raw as WidgetPosition).x !== "number" ||
    typeof (raw as WidgetPosition).y !== "number"
  ) {
    return null;
  }
  const { x, y } = raw as WidgetPosition;
  return { x, y };
}

export interface ViewportBounds {
  width: number;
  height: number;
  dockWidth: number;
  dockHeight: number;
}

/**
 * Clamp a position so the Dock stays fully visible within the viewport.
 * The Dock is not allowed to leave the viewport on any edge — if the
 * saved position would place it off-screen (window resized since the
 * last save, or dpi-scale change), it snaps back to the nearest edge.
 */
export function clampToViewport(
  pos: WidgetPosition,
  bounds: ViewportBounds,
): WidgetPosition {
  const maxX = Math.max(0, bounds.width - bounds.dockWidth);
  const maxY = Math.max(0, bounds.height - bounds.dockHeight);
  const x = Math.min(Math.max(pos.x, 0), maxX);
  const y = Math.min(Math.max(pos.y, 0), maxY);
  return { x, y };
}
