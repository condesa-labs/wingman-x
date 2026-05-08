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
 *      editor actually handled the event by checking BOTH (a) some
 *      listener called `preventDefault()` (`dispatchEvent` returns
 *      false) AND (b) one animation frame later the composer's text
 *      now contains our target string and differs from the snapshot
 *      taken before dispatch. The compound check rules out non-editor
 *      paste interceptors — a Chrome extension, analytics script, or
 *      defensive paste guard could `preventDefault()` without inserting
 *      text; if we trusted `preventDefault()` alone we would skip the
 *      execCommand fallback, return success, and downstream
 *      (`actions.ts`) would mark the candidate as `filled` even though
 *      the composer is empty.
 *   4. Fallback when paste isn't handled by the editor (the E2E
 *      fixture's plain contenteditable, or older hosts without
 *      ClipboardEvent / DataTransfer, or a non-editor interceptor that
 *      cancelled paste without inserting): `document.execCommand
 *      ('insertText', false, text)` replaces the selection and fires a
 *      real `input` event so the fixture's Tweet-button listener still
 *      flips on.
 *   5. Last resort if execCommand is unavailable or returns false:
 *      assign `textContent` directly and dispatch synthetic `beforeinput`
 *      / `input` events.
 *   6. Move the caret to the end so further typing appends naturally.
 *   7. Return `true` only if the composer's final text contains the
 *      target string. This is the contract `actions.ts` relies on to
 *      decide whether to POST `action: filled` — a silent fail (e.g.
 *      both paths cancelled with no insert) MUST surface as `false` so
 *      we don't mark a candidate as handled when the user has nothing
 *      typed.
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

  // Primary path: synthetic `paste` event. Lexical / DraftJS read the
  // DataTransfer's text/plain and apply it as a single React-state
  // update, calling preventDefault() to stop the browser's native
  // handling.
  let pasteCancelled = false;
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const pasteEvent = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    pasteCancelled = !el.dispatchEvent(pasteEvent);
  } catch {
    // ClipboardEvent / DataTransfer unavailable — fall through.
    pasteCancelled = false;
  }

  // Lexical's onPaste enqueues a React-state update; the DOM commit
  // lands within the same microtask / next animation frame. Wait one
  // rAF before reading textContent so the reconciliation has flushed.
  if (pasteCancelled) {
    await waitOneFrame(root);
  }

  // "Editor handled it" requires BOTH:
  //   (a) preventDefault was called (`pasteCancelled`), AND
  //   (b) the composer's text now equals the target after whitespace
  //       normalization — proof the composer is in the desired final
  //       state.
  // We deliberately compare against the FINAL desired state rather
  // than "text changed". If `beforeText` already equalled `text`
  // (e.g. the user filled once, navigated away, came back, clicked
  // Fill again — Lexical correctly no-ops the paste because the
  // selected target text is being replaced with itself), insisting on
  // a textContent delta would push us into the execCommand fallback
  // and re-introduce the original double-insertion bug. Conversely,
  // a non-editor paste interceptor that called preventDefault without
  // writing leaves `afterPasteText` empty (or unchanged garbage), so
  // strict equality with the target is false and we still fall
  // through to execCommand. (review-loop f1 + f3.)
  const afterPasteText = el.textContent ?? "";
  const handledByEditor =
    pasteCancelled && normalizeText(afterPasteText) === normalizeText(text);

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

  // Final verification: surface explicit failure if neither path
  // landed the text. The caller (`actions.ts`) uses this return value
  // to decide whether to POST `action: filled`; a silent failure here
  // would otherwise mark the candidate as handled with an empty
  // composer.
  return (el.textContent ?? "").includes(text);
}

/**
 * Collapse runs of whitespace into single spaces and trim. Used to
 * compare the editor's post-paste DOM textContent against the target
 * — Lexical / DraftJS may insert paragraph separators or trailing
 * newlines around the inserted text, which we want to treat as
 * equivalent for the "handled" check.
 */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Resolve after one animation frame on the document's owning view.
 * Used to give a React-managed contenteditable's reconciliation time
 * to commit DOM changes after a synthetic paste event. Falls back to
 * an immediate resolve when the host has no `requestAnimationFrame`
 * (older test environments).
 */
function waitOneFrame(root: Document): Promise<void> {
  const view = root.defaultView ?? globalThis;
  const raf = (view as { requestAnimationFrame?: typeof requestAnimationFrame })
    .requestAnimationFrame;
  if (typeof raf !== "function") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    raf(() => resolve());
  });
}
