/**
 * Pure SSE-frame parser. Extracted to its own module so it can be
 * exhaustively unit-tested in isolation from the streaming `fetch`
 * machinery in `scripts/watcher.ts`.
 *
 * Why a hand-rolled parser instead of `EventSource`?
 *   `EventSource` is unreliable in Node — it's a browser API surfaced
 *   by undici only in narrow circumstances, and it lacks the
 *   per-connection control we need (custom headers, AbortController,
 *   tunable backoff). The streaming-fetch + manual frame parser pattern
 *   matches what the extension's `background.ts` already uses, so the
 *   project keeps a single parser shape across both consumers.
 *
 * Frame grammar:
 *   Frames are separated by a blank line — i.e. the literal "\n\n".
 *   Within a frame, each line falls into one of:
 *     - `:something` — a comment (ignored)
 *     - `data:<text>` — contributes to the JSON payload (joined by "\n")
 *     - `event:<text>` — a named event (we don't use this yet)
 *     - `id:<text>` — last-event-id (we don't use this yet)
 *   Per the SSE spec, exactly one optional space immediately after the
 *   colon is stripped from the field value.
 *
 * The function returns `{ frames, remainder }`:
 *   - `frames`: an array of parsed frames in arrival order.
 *   - `remainder`: any trailing bytes that did NOT end with "\n\n".
 *     Callers feed this back in concatenated with the next chunk so a
 *     frame split across two chunks is reassembled correctly.
 */

export interface ParsedFrame {
  /** The joined `data:` lines, in order, separated by literal "\n". */
  data: string;
}

export interface ParseSseResult {
  frames: ParsedFrame[];
  remainder: string;
}

/**
 * Parse zero-or-more complete SSE frames from `buffer`. Anything that
 * doesn't end in the frame terminator is returned as `remainder` for
 * re-feed on the next chunk.
 */
export function parseSseFrame(buffer: string): ParseSseResult {
  const frames: ParsedFrame[] = [];
  let cursor = 0;
  while (true) {
    const sep = buffer.indexOf("\n\n", cursor);
    if (sep === -1) break;
    const raw = buffer.slice(cursor, sep);
    frames.push(parseOneFrame(raw));
    cursor = sep + 2;
  }
  return {
    frames,
    remainder: buffer.slice(cursor),
  };
}

function parseOneFrame(raw: string): ParsedFrame {
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    // Comments per SSE spec — ignore the entire line.
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      // Strip the leading "data:" prefix and exactly ONE optional space.
      let value = line.slice(5);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
      continue;
    }
    // event: / id: lines are recognised but not extracted — we don't
    // use them yet. Letting them fall through here keeps the parser
    // forward-compatible: when a future feature wants them we add a
    // field on ParsedFrame rather than reshaping the public return.
  }
  return {
    data: dataLines.join("\n"),
  };
}
