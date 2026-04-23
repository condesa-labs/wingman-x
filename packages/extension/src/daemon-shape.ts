/**
 * Daemon response shape guards — shared between popup/daemon-client
 * and content-script (review-loop f12, f13).
 *
 * Context:
 *   A co-located local HTTP service could happen to listen on the
 *   daemon's stale cached port and answer `GET /candidates` or
 *   `GET /suggestion` with JSON that LOOKS like a daemon response but
 *   isn't. We want to detect that case and fall back to
 *   `invalidate_port` + retry, not silently trust the response.
 *
 *   The guards here verify the FULL Candidate contract exported by
 *   the daemon — matching `packages/daemon/src/schemas.ts#CandidateSchema`
 *   — rather than a reduced subset (f13 feedback: "the new guards
 *   still only validate a subset of the daemon contract, so a
 *   squatting local service can still be accepted").
 *
 *   Why not import agent-kit's zod schemas?
 *     Extension source has no runtime dependency on agent-kit (or
 *     zod). Pulling zod in just for response validation would add
 *     ~8KB to the unpacked extension. A hand-rolled check of the
 *     same invariants keeps the extension self-contained.
 *     Schemas are duplicated in spirit, but the ONE daemon integration
 *     test in `packages/agent-kit/test/integration.test.ts` round-
 *     trips real candidates, so drift between the two validator sets
 *     surfaces loudly in CI.
 */

/** Must match `packages/daemon/src/schemas.ts#TWEET_URL_RE`. */
const TWEET_URL_RE =
  /^https:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/]+\/status\/\d+(?:[/?#].*)?$/;
/** Matches `z.string().datetime()` ISO-8601 UTC strings (what the daemon emits). */
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** Must match `packages/daemon/src/schemas.ts#StatusEnum`. */
const STATUS_VALUES: ReadonlySet<string> = new Set([
  "pending",
  "filled",
  "dismissed",
  "saved",
  "regen_requested",
]);
/** Must match `packages/daemon/src/schemas.ts#CandidateInputSchema.match_category`. */
const MATCH_CATEGORIES: ReadonlySet<string> = new Set([
  "selected",
  "topic",
  "trending",
]);

/**
 * Verify `value` is a full daemon-shaped Candidate. Used as a guard
 * before trusting a 2xx response from the cached port.
 */
export function isDaemonCandidate(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    typeof c.tweet_id === "string" &&
    c.tweet_id.length > 0 &&
    typeof c.tweet_url === "string" &&
    TWEET_URL_RE.test(c.tweet_url) &&
    typeof c.author_handle === "string" &&
    c.author_handle.length > 0 &&
    typeof c.tweet_text === "string" &&
    typeof c.suggested_reply === "string" &&
    c.suggested_reply.length > 0 &&
    typeof c.match_reason === "string" &&
    typeof c.match_category === "string" &&
    MATCH_CATEGORIES.has(c.match_category) &&
    Array.isArray(c.kb_refs) &&
    c.kb_refs.every((x) => typeof x === "string") &&
    typeof c.created_at === "string" &&
    ISO_DATETIME_RE.test(c.created_at) &&
    typeof c.status === "string" &&
    STATUS_VALUES.has(c.status) &&
    typeof c.status_updated_at === "string" &&
    ISO_DATETIME_RE.test(c.status_updated_at)
  );
}

/**
 * Guard for `GET /candidates` response body —
 * `{candidates: Candidate[]}`.
 */
export function isDaemonCandidatesListResponse(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const list = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(list)) return false;
  return list.every(isDaemonCandidate);
}

/**
 * Guard for `GET /suggestion?tweet_id=X` response body. A conforming
 * daemon echoes the requested `tweet_id` — mismatched ids also fail
 * the guard.
 */
export function isDaemonSuggestionResponse(
  body: unknown,
  expectedTweetId: string,
): boolean {
  if (!isDaemonCandidate(body)) return false;
  return (body as { tweet_id: string }).tweet_id === expectedTweetId;
}

/**
 * Header the daemon stamps on every response so callers can tell us
 * apart from any co-located service that happens to be listening on
 * the daemon's auto-bumped port range (review-loop f14). Closes the
 * 404-false-negative gap that body-shape validation alone leaves
 * open — the header is present on ALL response statuses.
 *
 * Must match `DAEMON_HEADER` exported from
 * `packages/daemon/src/server.ts`.
 */
export const DAEMON_IDENTITY_HEADER = "x-twitter-helper-daemon";

/**
 * Verify the response carries the daemon identity header. Callers
 * treat a missing/empty header as a stale-cache signal and drive an
 * `invalidate_port` + retry pass — which catches 404, 5xx, and any
 * other status a squatter might return, not just 200 with the wrong
 * body shape.
 */
export function hasDaemonIdentityHeader(res: Response): boolean {
  const value = res.headers.get(DAEMON_IDENTITY_HEADER);
  return typeof value === "string" && value.length > 0;
}
