/**
 * Inject text into Twitter's reply composer (CP06).
 *
 * The composer on twitter.com / x.com is a contenteditable `<div>`
 * managed by a React-driven editor (Lexical / DraftJS). It owns its own
 * text state and reconciles the DOM from that state on every render.
 *
 * Strategy (in order):
 *   1. Locate the composer:
 *        a. `[data-testid="tweetTextarea_0"]` — Twitter's stable hook.
 *        b. `article [contenteditable="true"]` — fallback if they ever
 *           rename the testid within a tweet-detail page.
 *        c. Last-ditch: any `[contenteditable="true"]` on the page.
 *   2. Focus it and select the current contents so the insertion
 *      REPLACES rather than appends.
 *   3. Dispatch a synthetic `paste` event carrying the text via a
 *      `DataTransfer`. Lexical / DraftJS treat paste as a single React-
 *      state update — exactly the path we want. We detect that the
 *      editor handled the event by inspecting `dispatchEvent`'s return
 *      value: any handler that calls `preventDefault()` (the editor
 *      always does, to stop the browser's native paste from also
 *      running) flips it to `false`. That signal is the difference
 *      between "Lexical accepted it, don't do anything else" and "no
 *      paste handler intercepted, fall through".
 *   4. Fallback when paste isn't handled (e.g. the E2E fixture's plain
 *      contenteditable, or older hosts without ClipboardEvent /
 *      DataTransfer): `document.execCommand('insertText', false, text)`
 *      replaces the selection and fires a real `input` event so the
 *      fixture's Tweet-button listener still flips on.
 *   5. Last resort if execCommand is unavailable or returns false:
 *      assign `textContent` directly and dispatch synthetic `beforeinput`
 *      / `input` events.
 *   6. Move the caret to the end so further typing appends naturally.
 *
 * Why not execCommand as the primary path?
 *   On Lexical / modern DraftJS, `execCommand('insertText')` produces
 *   the text TWICE: once via the browser's native command execution and
 *   once via the editor's `beforeinput` handler reconciling React state.
 *   The user observes the suggested reply pasted end-to-end with itself
 *   ("…IC leverage.this is a structural shift…"). A subsequent undo or
 *   range-delete then collapses the editor's single state update,
 *   removing all of the inserted text and leaving the composer blank.
 *   Routing through paste eliminates the double-insertion: only the
 *   editor's React-state path runs.
 *
 * Returns `true` on success; `false` if no composer could be located.
 */

export type CompositionHandle = HTMLElement;

/**
 * Locate Twitter's reply composer element using the documented
 * selector fallback chain. Exported for tests and for `actions.ts`.
 */
export function findComposer(
  root: Document = document,
): CompositionHandle | null {
  const byTestid = root.querySelector<HTMLElement>(
    '[data-testid="tweetTextarea_0"]',
  );
  if (byTestid !== null) return byTestid;

  const withinArticle = root.querySelector<HTMLElement>(
    'article [contenteditable="true"]',
  );
  if (withinArticle !== null) return withinArticle;

  const anyEditable = root.querySelector<HTMLElement>(
    '[contenteditable="true"]',
  );
  return anyEditable;
}

/**
 * Fill the composer with `text` using a React-compatible strategy.
 * Returns `true` on successful insertion.
 */
export async function fillReplyComposer(
  text: string,
  root: Document = document,
): Promise<boolean> {
  const el = findComposer(root);
  if (el === null) return false;

  el.focus();

  // Select all existing contents so the insertion REPLACES rather than
  // appends. A pristine Twitter composer is empty — but a user may
  // have typed already, and CP06 semantics say "fill", not "append".
  const selection = root.defaultView?.getSelection() ?? window.getSelection();
  if (selection !== null) {
    selection.removeAllRanges();
    const allRange = root.createRange();
    allRange.selectNodeContents(el);
    selection.addRange(allRange);
  }

  // Primary path: synthetic `paste` event. Lexical / DraftJS will read
  // the DataTransfer's text/plain and apply it as a single state update,
  // calling preventDefault() to stop the browser's native handling.
  // `dispatchEvent` returns false when any listener prevented default —
  // that's the signal that the editor consumed the event and we MUST
  // NOT also invoke execCommand (doing so produces the double-insertion
  // the docblock above describes).
  let handledByEditor = false;
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const pasteEvent = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    handledByEditor = !el.dispatchEvent(pasteEvent);
  } catch {
    // ClipboardEvent / DataTransfer unavailable — fall through.
    handledByEditor = false;
  }

  if (!handledByEditor) {
    // No paste handler intercepted (E2E fixture, or any plain
    // contenteditable). Use execCommand to replace the selection and
    // fire a native `input` event the fixture's Tweet-button listener
    // depends on.
    let inserted = false;
    try {
      inserted = root.execCommand("insertText", false, text);
    } catch {
      // Some environments (strict MV3 worlds, older Firefox) throw
      // rather than returning `false`. Fall through to the synthetic
      // path below.
      inserted = false;
    }

    if (!inserted) {
      // Last resort: directly set textContent and dispatch synthetic
      // input events. Plain contenteditable hosts surface the change to
      // listeners; React-managed editors would already have been served
      // by the paste path above, so this branch only runs in degraded
      // environments.
      el.textContent = text;
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: text,
          bubbles: true,
          cancelable: true,
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertText",
          data: text,
          bubbles: true,
          cancelable: false,
        }),
      );
    }
  }

  // Move the caret to the end so further typing appends naturally.
  if (selection !== null) {
    selection.removeAllRanges();
    const endRange = root.createRange();
    endRange.selectNodeContents(el);
    endRange.collapse(false);
    selection.addRange(endRange);
  }

  return true;
}
