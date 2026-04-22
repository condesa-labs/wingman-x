/**
 * Unit tests for `position-store` — the Dock's position persistence helpers.
 *
 * CP05 acceptance criteria covered here:
 *   - Released position is saved to `chrome.storage.local` under the key
 *     `widget_position`.
 *   - Next page load restores the saved position (within 1 px tolerance).
 *
 * The Dock's drag handler writes the final {x, y} after pointerup, and the
 * content-script mount path reads the stored value (if any) before
 * applying the right-edge default. We unit-test both code paths with an
 * in-memory `chrome.storage.local` stand-in.
 *
 * Design note — why integer px?
 *   The position-store rounds to integer px on save so a round-trip never
 *   drifts more than 0 px. The spec allows 1 px tolerance; we pick a
 *   strict 0 px policy because float rounding error can accumulate across
 *   successive drag sessions (save → restore → save). Integer is
 *   cheapest and leaves the spec's 1 px tolerance as true headroom.
 */
import { describe, expect, it } from "vitest";
import {
  clampToViewport,
  loadPosition,
  savePosition,
  STORAGE_KEY,
  type LocalStorageLike,
  type WidgetPosition,
} from "../../src/content/position-store.js";

/** In-memory chrome.storage.local stand-in. */
function makeStorage(
  initial: Record<string, unknown> = {},
): LocalStorageLike & { peek: () => Record<string, unknown> } {
  let store: Record<string, unknown> = { ...initial };
  return {
    get: async (key: string) =>
      key in store ? { [key]: store[key] } : { [key]: undefined },
    set: async (items: Record<string, unknown>) => {
      store = { ...store, ...items };
    },
    remove: async (key: string) => {
      const { [key]: _drop, ...rest } = store;
      void _drop;
      store = rest;
    },
    peek: () => ({ ...store }),
  };
}

describe("savePosition", () => {
  it("writes to chrome.storage.local under the documented key", async () => {
    const storage = makeStorage();
    await savePosition({ x: 120, y: 340 }, { storage });

    const persisted = storage.peek()[STORAGE_KEY] as WidgetPosition;
    expect(persisted).toEqual({ x: 120, y: 340 });
  });

  it("rounds to integer px so round-trip is 0 px drift", async () => {
    const storage = makeStorage();
    await savePosition({ x: 12.4, y: 340.6 }, { storage });

    const persisted = storage.peek()[STORAGE_KEY] as WidgetPosition;
    expect(persisted).toEqual({ x: 12, y: 341 });
  });

  it("documents the storage key as 'widget_position'", () => {
    // Guardrail: the spec calls this key out by name. If the key ever
    // gets renamed we want the test to fail loudly.
    expect(STORAGE_KEY).toBe("widget_position");
  });
});

describe("loadPosition", () => {
  it("returns null when nothing is persisted", async () => {
    const storage = makeStorage();
    const loaded = await loadPosition({ storage });
    expect(loaded).toBeNull();
  });

  it("returns the saved position when present", async () => {
    const storage = makeStorage({
      [STORAGE_KEY]: { x: 88, y: 240 },
    });
    const loaded = await loadPosition({ storage });
    expect(loaded).toEqual({ x: 88, y: 240 });
  });

  it("ignores malformed values (not an object / missing keys)", async () => {
    // Corrupted state should not throw and should not hand the Dock a
    // partial position. The Dock falls back to the right-edge default.
    const bad: unknown[] = [null, "x=5,y=5", 42, { x: 10 }, { y: 10 }, {}];
    for (const v of bad) {
      const storage = makeStorage({ [STORAGE_KEY]: v });
      const loaded = await loadPosition({ storage });
      expect(loaded).toBeNull();
    }
  });
});

describe("clampToViewport", () => {
  it("returns the position unchanged when inside the viewport", () => {
    const clamped = clampToViewport(
      { x: 100, y: 100 },
      { width: 800, height: 600, dockWidth: 220, dockHeight: 44 },
    );
    expect(clamped).toEqual({ x: 100, y: 100 });
  });

  it("clamps x/y so the dock is not off-screen right/bottom", () => {
    const clamped = clampToViewport(
      { x: 900, y: 700 },
      { width: 800, height: 600, dockWidth: 220, dockHeight: 44 },
    );
    // x = width - dockWidth = 800 - 220 = 580
    // y = height - dockHeight = 600 - 44 = 556
    expect(clamped).toEqual({ x: 580, y: 556 });
  });

  it("clamps negative x/y back into the viewport", () => {
    const clamped = clampToViewport(
      { x: -50, y: -30 },
      { width: 800, height: 600, dockWidth: 220, dockHeight: 44 },
    );
    expect(clamped).toEqual({ x: 0, y: 0 });
  });
});
