/**
 * Truncate `s` to at most `max` characters. If the string is longer than
 * `max`, keep the leading `max - 1` characters and append a single
 * ellipsis glyph (U+2026). The final length is exactly `max`, so layout
 * never jitters when a string is cut.
 *
 * We intentionally count the ellipsis toward the budget — a label marked
 * "≤ 80 chars" in the spec must really be ≤ 80 chars, not 81.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}\u2026`;
}
