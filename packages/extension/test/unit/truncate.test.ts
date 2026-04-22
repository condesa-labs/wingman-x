/**
 * Unit tests for `truncate` — the popup's text-preview shortener.
 *
 * CP08 scope: author handle + tweet preview + reply preview render as
 * "≤ 80 chars + ellipsis" cards. The truncation helper is the single
 * place that policy lives, so it has a dedicated unit test.
 *
 * Coverage:
 *   - under-limit strings pass through unchanged
 *   - exact-limit strings pass through unchanged (no ellipsis)
 *   - over-limit strings get an ellipsis, with the trailing glyph
 *     counted toward the `max` so final length === `max`
 */
import { describe, expect, it } from "vitest";
import { truncate } from "../../src/popup/truncate.js";

describe("truncate", () => {
  it("returns the string unchanged when shorter than max", () => {
    expect(truncate("short", 80)).toBe("short");
  });

  it("returns the string unchanged when exactly at the max", () => {
    const s = "x".repeat(80);
    expect(truncate(s, 80)).toBe(s);
    expect(truncate(s, 80).length).toBe(80);
  });

  it("truncates and appends an ellipsis when over the max", () => {
    const s = "x".repeat(100);
    const out = truncate(s, 80);
    // Result is exactly `max` characters long: 79 'x' + one ellipsis glyph.
    expect(out.length).toBe(80);
    expect(out.endsWith("\u2026")).toBe(true);
    expect(out.startsWith("x".repeat(79))).toBe(true);
  });

  it("handles empty strings without throwing", () => {
    expect(truncate("", 80)).toBe("");
  });
});
