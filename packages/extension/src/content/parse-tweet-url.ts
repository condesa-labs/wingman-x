/**
 * Parse a Twitter / X tweet-detail URL and return its numeric `tweet_id`
 * as a string. Returns `null` when the URL is not a tweet-detail page.
 *
 * Accepted hosts:
 *   - `twitter.com` (+ `*.twitter.com` subdomains e.g. `mobile.twitter.com`)
 *   - `x.com` (+ `*.x.com`)
 *   - `localhost` (for the CP04 E2E fixture served on localhost; see
 *     the `http://localhost/(handle)/status/(id)` match pattern in manifest)
 *
 * Accepted path shape:
 *   - `/<handle>/status/<numeric-id>` (with or without trailing slash)
 *
 * Tracking params (`?s=20&t=...`) and hash fragments are ignored because
 * the `URL` constructor parses them into separate fields; they do not
 * appear in `pathname`.
 *
 * The function must NEVER throw: Twitter-initiated SPA navigations can
 * hand us arbitrary strings via `window.location.href` during route
 * changes, so a `try/catch` wraps the whole thing.
 *
 * Design note — why a string, not a number?
 *   Tweet ids are 64-bit snowflakes. JS numbers lose precision above
 *   2^53. The daemon contract (`tweet_id: string`) also treats them as
 *   strings, so the content script hands the raw digits through as text.
 */

/** Path segment regex: /<anything-but-slash>/status/<digits>(/ or end). */
const TWEET_PATH_RE = /^\/[^/]+\/status\/(\d+)(?:\/|$)/;

/**
 * True when `host` is one of the allow-listed tweet-detail hosts.
 *
 * `endsWith(".twitter.com")` covers `mobile.twitter.com` and the older
 * `m.twitter.com` without opening the function up to look-alike domains
 * (e.g. `evil-twitter.com`).
 */
function isAllowedHost(host: string): boolean {
  return (
    host === "twitter.com" ||
    host === "x.com" ||
    host === "localhost" ||
    host.endsWith(".twitter.com") ||
    host.endsWith(".x.com")
  );
}

export function parseTweetId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not a parseable URL — definitely not a tweet detail page.
    return null;
  }

  if (!isAllowedHost(url.hostname)) return null;

  const match = url.pathname.match(TWEET_PATH_RE);
  return match?.[1] ?? null;
}
