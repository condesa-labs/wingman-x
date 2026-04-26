/**
 * Behavioral unit tests for the URL-match guard in `handleAction("fill", …)`
 * (CP04 of the watcher task).
 *
 * Why this guard exists:
 *   The Dock is mounted against a specific tweet's id at mount-time. SPA
 *   navigations on twitter.com / x.com can move the user to a new tweet
 *   *without* unmounting the Dock (no full page reload fires). If the user
 *   then clicks Fill, the previously-captured `ctx.tweetId` no longer
 *   matches the page they're looking at — filling text into the *new*
 *   tweet's composer would silently misattribute the reply. The guard
 *   re-parses `window.location.href` and bails out with a toast when the
 *   live tweet id has drifted.
 *
 * The two behaviors under test mirror the two branches of the guard:
 *
 *   (a) Positive — `parseTweetId(window.location.href) === ctx.tweetId`:
 *       `fillReplyComposer` MUST be invoked with `ctx.suggestedReply`.
 *
 *   (b) Negative — `parseTweetId` returns a different id (or null):
 *       `fillReplyComposer` MUST NOT be invoked, AND `showToast` MUST be
 *       invoked with a message containing the substring `"out of sync"`
 *       (the live patch text is `"Reply out of sync — reopen this
 *       candidate from the popup"`).
 *
 * Mocking strategy:
 *   - `vi.mock` on the three sibling modules so we observe call args
 *     without exercising the real DOM (vitest env is `node`).
 *   - `vi.stubGlobal("window", …)` to control `window.location.href` since
 *     the node env has no global `window`.
 *   - In the positive case `fillReplyComposer` is stubbed to resolve
 *     `false`, which short-circuits the post-fill side effects
 *     (`postAction`, `onDismiss`, `requestBadgeRefresh`) — keeping the
 *     test focused on the guard's branching, not the success-path tail.
 *   - The mock paths use `.js` suffix to match `actions.ts`'s imports
 *     (the project compiles with TS NodeNext-style ESM specifiers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the three modules `actions.ts` imports. Vitest hoists `vi.mock`
// above imports, so the mocked factories are in place when `actions.ts`
// is first evaluated.
vi.mock("../../src/content/parse-tweet-url.js", () => ({
  parseTweetId: vi.fn(),
}));
vi.mock("../../src/content/fill-reply.js", () => ({
  fillReplyComposer: vi.fn(),
}));
vi.mock("../../src/content/toast.js", () => ({
  showToast: vi.fn(),
  clearToast: vi.fn(),
  TOAST_ID: "twh-toast",
}));
// `actions.ts` also imports `unmountDock` from `dock.js`. The fill path
// only calls it inside the success branch (after fillReplyComposer
// returns true), which we never hit in these tests — but mocking it
// still keeps the import graph from pulling in the real DOM-touching
// module under the `node` test environment.
vi.mock("../../src/content/dock.js", () => ({
  unmountDock: vi.fn(),
}));

import { handleAction, type ActionContext } from "../../src/content/actions.js";
import { fillReplyComposer } from "../../src/content/fill-reply.js";
import { parseTweetId } from "../../src/content/parse-tweet-url.js";
import { showToast } from "../../src/content/toast.js";

const mockedParseTweetId = vi.mocked(parseTweetId);
const mockedFillReplyComposer = vi.mocked(fillReplyComposer);
const mockedShowToast = vi.mocked(showToast);

/** Build a minimal ActionContext for the fill path. */
function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tweetId: "1234567890",
    suggestedReply: "hello world",
    // `port: null` skips the `postAction` POST so the test does not need
    // to mock `fetch`. The guard runs *before* this matters.
    port: null,
    // Provide a no-op `onDismiss` so the success-branch teardown does
    // not fall through to the real `unmountDock`.
    onDismiss: vi.fn(),
    ...overrides,
  };
}

describe("handleAction('fill', …) — URL-match guard (CP04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a `window` global (vitest env is `node` — no DOM by default).
    // Only `location.href` is read by the guard; everything else is unused.
    vi.stubGlobal("window", {
      location: { href: "https://x.com/jack/status/1234567890" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("(a) positive — when parseTweetId(URL) === ctx.tweetId, fillReplyComposer is invoked with the suggested reply", async () => {
    const ctx = makeCtx({
      tweetId: "1234567890",
      suggestedReply: "matched-reply",
    });
    mockedParseTweetId.mockReturnValue("1234567890");
    // Resolve `false` so the post-fill side-effect tail (postAction /
    // onDismiss / requestBadgeRefresh) short-circuits and the test stays
    // scoped to the guard's branching behavior.
    mockedFillReplyComposer.mockResolvedValue(false);

    await handleAction("fill", ctx);

    expect(mockedParseTweetId).toHaveBeenCalledWith(
      "https://x.com/jack/status/1234567890",
    );
    expect(mockedFillReplyComposer).toHaveBeenCalledTimes(1);
    expect(mockedFillReplyComposer).toHaveBeenCalledWith("matched-reply");
    // The guard must NOT show a toast on the matching path.
    expect(mockedShowToast).not.toHaveBeenCalled();
  });

  it("(b) negative — when parseTweetId(URL) !== ctx.tweetId, fillReplyComposer is NOT invoked and showToast fires with 'out of sync'", async () => {
    const ctx = makeCtx({ tweetId: "1234567890" });
    // Live URL parses to a *different* id — the SPA-nav drift case.
    mockedParseTweetId.mockReturnValue("9999999999");

    await handleAction("fill", ctx);

    expect(mockedFillReplyComposer).not.toHaveBeenCalled();
    expect(mockedShowToast).toHaveBeenCalledTimes(1);
    const [toastMessage] = mockedShowToast.mock.calls[0]!;
    expect(toastMessage).toContain("out of sync");
  });

  it("(b') negative — when parseTweetId(URL) returns null (non-tweet page), fillReplyComposer is NOT invoked and showToast fires with 'out of sync'", async () => {
    const ctx = makeCtx({ tweetId: "1234567890" });
    // E.g. SPA navigated to /home — no /status/<id> in the path.
    mockedParseTweetId.mockReturnValue(null);

    await handleAction("fill", ctx);

    expect(mockedFillReplyComposer).not.toHaveBeenCalled();
    expect(mockedShowToast).toHaveBeenCalledTimes(1);
    const [toastMessage] = mockedShowToast.mock.calls[0]!;
    expect(toastMessage).toContain("out of sync");
  });
});
