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
    let observedClipboardText: string | undefined;
    el.addEventListener("paste", (event) => {
      pasteCount += 1;
      // Verify the synthetic event carried the expected payload — a
      // partial mitigation of review-loop f2 (the unit test's stub
      // could otherwise vacuously accept any incoming paste).
      observedClipboardText = (event as ClipboardEvent).clipboardData?.getData(
        "text/plain",
      );
      if (typeof observedClipboardText === "string") {
        el.textContent = observedClipboardText;
      }
      event.preventDefault();
    });

    const { spy, restore } = installExecCommandStub();
    try {
      const ok = await fillReplyComposer(REPLY_TEXT, document);

      expect(ok).toBe(true);
      expect(pasteCount).toBe(1);
      // The synthetic ClipboardEvent must carry the exact text via
      // text/plain — the contract Lexical's onPaste handler reads.
      expect(observedClipboardText).toBe(REPLY_TEXT);
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

  it("falls through to execCommand when paste is cancelled but no text was inserted", async () => {
    // Stand in for a non-editor paste interceptor (Chrome extension,
    // analytics, defensive guard) that calls preventDefault WITHOUT
    // writing any text. Pre-fix this would have been treated as
    // "editor handled it", silent-failing the fill and causing
    // actions.ts to POST `action: filled` with an empty composer.
    // Post-fix: the compound check (preventDefault AND textContent
    // changed AND contains target) detects the no-write case and
    // falls through to execCommand. (review-loop f1.)
    const el = mountComposer();

    let pasteCount = 0;
    el.addEventListener("paste", (event) => {
      pasteCount += 1;
      // Cancel the event, but DO NOT modify the composer.
      event.preventDefault();
    });

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

    try {
      const ok = await fillReplyComposer(REPLY_TEXT, document);

      expect(ok).toBe(true);
      expect(pasteCount).toBe(1);
      // Compound check rejected paste-cancelled-without-insert and
      // fell through to execCommand.
      expect(spy).toHaveBeenCalledWith("insertText", false, REPLY_TEXT);
      expect(el.textContent).toBe(REPLY_TEXT);
    } finally {
      restore();
    }
  });

  it("treats no-op paste of already-correct text as handled — does NOT call execCommand", async () => {
    // f3 (review-loop round 2): when the composer already contains
    // the target reply (user filled once, navigated away, came back,
    // clicked Fill again), Lexical's onPaste correctly replaces the
    // selected target with the same target — `textContent` is
    // unchanged but the editor handled the event. The "handled"
    // predicate must accept this case; otherwise we fall through to
    // execCommand and append the reply a second time, re-introducing
    // the original double-insertion bug.
    const el = mountComposer();
    el.textContent = REPLY_TEXT;

    let pasteCount = 0;
    el.addEventListener("paste", (event) => {
      pasteCount += 1;
      const data = (event as ClipboardEvent).clipboardData?.getData(
        "text/plain",
      );
      // Editor "handles" by setting the same text back — no DOM delta.
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
      // Critical: must NOT fall through to execCommand. If it did, the
      // appended second copy of REPLY_TEXT would re-create the
      // original double-insertion bug under the "fill an already-
      // filled composer" path.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("returns false when the composer ends up with duplicated content after both paths", async () => {
    // f4 (review-loop round 3): the function's final return MUST
    // reject a duplicated end state. A naive `.includes(text)` check
    // would say "true" because "TEXTTEXT".includes("TEXT") is true,
    // and the caller (`actions.ts`) would then POST `action: filled`
    // against a visibly broken composer. Strict-equality-with-
    // normalization surfaces the failure.
    //
    // To force the duplicated state to survive into the final return,
    // we (a) make the paste handler write the duplicate (turns off
    // the editor-handled fast path because the predicate rejects the
    // state) and (b) stub execCommand to claim success without
    // modifying textContent (turns off the cleanup path). What's left
    // is the duplicated string, and the final return value is the
    // signal under test.
    const el = mountComposer();

    el.addEventListener("paste", (event) => {
      el.textContent = REPLY_TEXT + REPLY_TEXT;
      event.preventDefault();
    });

    const { restore } = installExecCommandStub(() => true);
    try {
      const ok = await fillReplyComposer(REPLY_TEXT, document);

      expect(ok).toBe(false);
      expect(el.textContent).toBe(REPLY_TEXT + REPLY_TEXT);
    } finally {
      restore();
    }
  });

  it("returns true when the editor's post-fill text differs only by whitespace normalization (NBSP, trailing newlines)", async () => {
    // f4 (review-loop round 3): a successful Lexical paste may insert
    // NBSP between words or trail a paragraph-separator newline. The
    // visible text matches the target after whitespace normalization;
    // the function MUST report success (raw `.includes(target)` would
    // wrongly return false on the NBSP-substitution case).
    const el = mountComposer();

    const TARGET = "hello world";
    const NORMALIZED_EQUIVALENT = `hello world\n`;

    el.addEventListener("paste", (event) => {
      el.textContent = NORMALIZED_EQUIVALENT;
      event.preventDefault();
    });

    const { spy, restore } = installExecCommandStub();
    try {
      const ok = await fillReplyComposer(TARGET, document);

      expect(ok).toBe(true);
      expect(el.textContent).toBe(NORMALIZED_EQUIVALENT);
      // Critical: must NOT fall through to execCommand. The editor's
      // text already equals the target after normalization.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("falls back to the textContent last-resort path and returns true when paste and execCommand both decline", async () => {
    // Defense-in-depth contract under degraded environments: if both
    // the paste path AND execCommand decline (paste cancelled with no
    // insert; execCommand returns false), the last-resort path
    // (`textContent = text` + synthetic InputEvents) takes over and
    // lands the text. This test documents that contract — the
    // function returns true because the last-resort path succeeded.
    // (To force the deeper silent-fail return-false branch we would
    // also need to block the textContent setter, which is a heavier
    // fixture than this unit test layer covers.) — CodeRabbit nit
    // on PR #4: rename so the title matches the asserted behavior.
    const el = mountComposer();

    el.addEventListener("paste", (event) => {
      event.preventDefault();
    });

    const { restore } = installExecCommandStub(
      // Stub returns false (browser ignored it) and writes nothing.
      () => false,
    );

    try {
      const ok = await fillReplyComposer(REPLY_TEXT, document);

      expect(ok).toBe(true);
      expect(el.textContent).toBe(REPLY_TEXT);
    } finally {
      restore();
    }
  });

  it("calls requestAnimationFrame with the view as receiver — guards against 'Illegal invocation' on real Chrome/Firefox", async () => {
    // CodeRabbit critical (PR #4): `const raf = view.requestAnimationFrame`
    // followed by `raf(cb)` is a detached call — Chrome/Firefox throw
    // `TypeError: Illegal invocation` because Window-bound Web APIs
    // require the window as the receiver. happy-dom does NOT enforce
    // the receiver check, so a naive call passes unit tests but
    // breaks on real twitter.com / x.com. This test installs a
    // requestAnimationFrame stub that captures `this` and asserts it
    // was the view.
    const el = mountComposer();
    el.addEventListener("paste", (event) => {
      event.preventDefault();
      const data = (event as ClipboardEvent).clipboardData?.getData(
        "text/plain",
      );
      if (typeof data === "string") {
        el.textContent = data;
      }
    });

    let receiverWasView = false;
    const view = window;
    const originalRaf = view.requestAnimationFrame;
    view.requestAnimationFrame = function rafSpy(
      this: unknown,
      cb: FrameRequestCallback,
    ): number {
      receiverWasView = this === view;
      return originalRaf.call(view, cb);
    } as typeof view.requestAnimationFrame;

    const { restore } = installExecCommandStub();

    try {
      const ok = await fillReplyComposer(REPLY_TEXT, document);

      expect(ok).toBe(true);
      // A regression that detaches the call (`raf(cb)` instead of
      // `raf.call(view, cb)`) would leave `this === undefined` here
      // and would throw on real Chrome/Firefox.
      expect(receiverWasView).toBe(true);
    } finally {
      view.requestAnimationFrame = originalRaf;
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
