/**
 * Inject text into Twitter's reply composer (CP06).
 *
 * The composer on twitter.com / x.com is a contenteditable `<div>`
 * rendered by a React tree. Writing to `.textContent` directly would
 * show the text in the DOM but leave React's internal state stale — so
 * the "Tweet" button stays disabled and pressing it submits nothing.
 *
 * The reliable workaround is to dispatch a real InputEvent through the
 * browser so React's `onBeforeInput` / `onInput` handlers see the
 * change and commit it to state. `document.execCommand('insertText')`
 * does exactly this: despite the "deprecated" banner on MDN, it is the
 * documented path used by browser extensions, password managers and
 * Twitter's own in-product clients to drive contenteditable composers
 * without relying on React internals.
 *
 * Strategy:
 *   1. Locate the composer:
 *        a. `[data-testid="tweetTextarea_0"]` — Twitter's stable hook.
 *        b. `article [contenteditable="true"]` — fallback if they ever
 *           rename the testid within a tweet-detail page.
 *        c. Last-ditch: any `[contenteditable="true"]` on the page.
 *   2. Focus it (execCommand requires focus in most browsers).
 *   3. Select the current contents (if any) so we replace, not append.
 *   4. Call `document.execCommand('insertText', false, text)`.
 *   5. Fallback if execCommand is unavailable or returns `false`:
 *      dispatch a synthetic `InputEvent` with `inputType="insertText"`
 *      AND manually update `textContent` so non-React fixtures still
 *      observe the change (the simulated Tweet button in our fixture
 *      only listens on `input`, so InputEvent alone is enough there).
 *   6. Move the caret to the end so the user can keep typing.
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

  // Select all existing contents so execCommand replaces rather than
  // appends. A pristine Twitter composer is empty — but a user may
  // have typed already, and CP06 semantics say "fill", not "append".
  const selection = root.defaultView?.getSelection() ?? window.getSelection();
  if (selection !== null) {
    selection.removeAllRanges();
    const allRange = root.createRange();
    allRange.selectNodeContents(el);
    selection.addRange(allRange);
  }

  let inserted = false;
  try {
    // execCommand dispatches an `input` InputEvent that React reads,
    // so the internal state syncs and the Tweet button enables.
    inserted = root.execCommand("insertText", false, text);
  } catch {
    // Some environments (strict MV3 worlds, older Firefox) throw rather
    // than returning `false`. Fall through to the synthetic path.
    inserted = false;
  }

  if (!inserted) {
    // Fallback for environments without execCommand support. We
    // manually update textContent AND dispatch a synthetic InputEvent
    // so listeners (including React and our fixture) still observe the
    // change. Note: in real React this fallback does NOT sync state
    // because React tracks the native valueTracker on <input>/<textarea>
    // only — but for contenteditable React relies on InputEvent, so the
    // synthetic dispatch is usually enough.
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
