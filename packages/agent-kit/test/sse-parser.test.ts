import { describe, expect, it } from "vitest";
import { parseSseFrame } from "../src/sse-parser.js";

/**
 * Pure-function tests for the SSE frame parser. These cases mirror the
 * spec's CP05 acceptance bullets: data: lines, comment lines, blank-line
 * separators, multi-line data, partial-frame remainder buffering.
 *
 * Frames are separated by "\n\n". Within a frame:
 *   - lines starting with `data:` contribute to the payload (joined by "\n")
 *   - lines starting with `:` are comments and contribute no payload
 *   - `event:` / `id:` lines are recognised but only `data:` is extracted
 *     for downstream JSON parsing
 */

describe("parseSseFrame", () => {
  it("returns empty frames and empty remainder for empty buffer", () => {
    const out = parseSseFrame("");
    expect(out.frames).toEqual([]);
    expect(out.remainder).toBe("");
  });

  it("parses one complete frame ending in \\n\\n with empty remainder", () => {
    const out = parseSseFrame('data: {"hello":"world"}\n\n');
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0]!.data).toBe('{"hello":"world"}');
    expect(out.remainder).toBe("");
  });

  it("parses two complete frames in one buffer", () => {
    const out = parseSseFrame('data: a\n\ndata: b\n\n');
    expect(out.frames).toHaveLength(2);
    expect(out.frames[0]!.data).toBe("a");
    expect(out.frames[1]!.data).toBe("b");
    expect(out.remainder).toBe("");
  });

  it("buffers a partial frame as remainder when no terminator is present", () => {
    const out = parseSseFrame("data: partial");
    expect(out.frames).toEqual([]);
    expect(out.remainder).toBe("data: partial");
  });

  it("handles a comment-only frame (':heartbeat\\n\\n') with empty data", () => {
    const out = parseSseFrame(":heartbeat\n\n");
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0]!.data).toBe("");
    expect(out.remainder).toBe("");
  });

  it("joins multi-line data fields with newlines", () => {
    const out = parseSseFrame("data: line1\ndata: line2\n\n");
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0]!.data).toBe("line1\nline2");
  });

  it("ignores event: and id: lines, extracting only data:", () => {
    const out = parseSseFrame('event: foo\nid: 42\ndata: payload\n\n');
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0]!.data).toBe("payload");
  });

  it("returns one frame plus the partial frame as remainder for a mixed buffer", () => {
    const out = parseSseFrame("data: complete\n\ndata: par");
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0]!.data).toBe("complete");
    expect(out.remainder).toBe("data: par");
  });

  it("preserves leading whitespace stripping (a single space after `data:`)", () => {
    // Per SSE spec, exactly one optional space after the colon is stripped.
    const out = parseSseFrame("data: hello\n\n");
    expect(out.frames[0]!.data).toBe("hello");
    const out2 = parseSseFrame("data:hello\n\n");
    expect(out2.frames[0]!.data).toBe("hello");
  });
});
