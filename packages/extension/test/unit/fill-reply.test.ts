/**
 * @vitest-environment happy-dom
 *
 * Regression tests for `fillReplyComposer` against two host shapes:
 *
 *   (1) Lexical / DraftJS-like contenteditable — the host registers a
 *       `paste` listener that calls `preventDefault()` and applies the
 *       text via its own state. `fillReplyComposer` MUST route through
 *       that paste path and MUST NOT also invoke `execCommand`, because
 *       doing both produces the double-insertion the user reported
 *       ("…IC leverage.this is a structural shift…" — same text twice
 *       end-to-end with no separator).
 *
 *   (2) Plain contenteditable (the E2E fixture) — no paste handler. The
 *       function MUST fall through to `execCommand('insertText', …)` so
 *       the fixture's `input`-event-driven Tweet-button listener still
 *       enables, preserving CP06's React-sync canary.
 *
 * The Lexical-style branch is the bug fix. The plain-contenteditable
 * branch is the no-regression guarantee for the existing E2E.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fillReplyComposer } from "../../src/content/fill-reply.js";

const REPLY_TEXT = "this is a single insertion";

function mountComposer(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("contenteditable", "true");
  el.setAttribute("data-testid", "tweetTextarea_0");
  document.body.appendChild(el);
  return el;
}

function clearBody(): void {
  while (document.body.firstChild !== null) {
    document.body.removeChild(document.body.firstChild);
  }
}

beforeEach(() => {
  clearBody();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * happy-dom doesn't ship `document.execCommand`, so each test installs
 * its own stub via `Object.defineProperty`. The stub records calls + can
 * emulate the native-browser behaviour for the plain-contenteditable
 * branch (write text, fire input event).
 */
function installExecCommandStub(
  impl: (cmd: string, showUI?: boolean, value?: string) => boolean = () =>
    false,
): {
  spy: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const spy = vi.fn(impl);
  const original = (document as unknown as { execCommand?: unknown })
    .execCommand;
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    writable: true,
    value: spy,
  });
  return {
    spy,
    restore: () => {
      if (original === undefined) {
        delete (document as unknown as { execCommand?: unknown }).execCommand;
      } else {
        Object.defineProperty(document, "execCommand", {
          configurable: true,
          writable: true,
          value: original,
        });
      }
    },
  };
}

describe("Lexical / DraftJS-style host (paste handler calls preventDefault)", () => {
  it("routes insertion through the paste event and does NOT call execCommand", async () => {
    const el = mountComposer();

    // Stand in for Lexical: when paste fires, read the DataTransfer's
    // text/plain, apply it as a single state update, and preventDefault
    // so the browser doesn't ALSO insert. This mirrors how Lexical's
    // onPaste handler behaves on real twitter.com / x.com.
    let pasteCount = 0;
    el.addEventListener("paste", (event) => {
      pasteCount += 1;
      const data = (event as ClipboardEvent).clipboardData?.getData(
        "text/plain",
      );
      if (typeof data === "string") {
        el.textContent = data;
      }
      event.preventDefault();
    });

    const { spy, restore } = installExecCommandStub();
    try {
      const ok = await fillReplyComposer(REPLY_TEXT, document);

      expect(ok).toBe(true);
      expect(pasteCount).toBe(1);
      expect(el.textContent).toBe(REPLY_TEXT);
      // Critical: no execCommand fallback fired. If it did, real X
      // would insert the text twice — once via paste, once via
      // execCommand — and the user would see the duplicate from the
      // bug report.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("plain contenteditable host (fixture-style — no paste handler)", () => {
  it("falls through to execCommand so the Tweet-button input listener still fires", async () => {
    const el = mountComposer();

    const { spy, restore } = installExecCommandStub(
      (cmd: string, _showUI?: boolean, value?: string) => {
        if (cmd !== "insertText" || typeof value !== "string") return false;
        el.textContent = value;
        el.dispatchEvent(
          new Event("input", { bubbles: true, cancelable: false }),
        );
        return true;
      },
    );

    let inputCount = 0;
    el.addEventListener("input", () => {
      inputCount += 1;
    });

    try {
      const ok = await fillReplyComposer(REPLY_TEXT, document);

      expect(ok).toBe(true);
      expect(spy).toHaveBeenCalledWith("insertText", false, REPLY_TEXT);
      expect(el.textContent).toBe(REPLY_TEXT);
      // Fixture's Tweet button enables off this input event, so the
      // count must be at least 1.
      expect(inputCount).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });
});

describe("missing composer", () => {
  it("returns false when no contenteditable is present", async () => {
    const ok = await fillReplyComposer(REPLY_TEXT, document);
    expect(ok).toBe(false);
  });
});
