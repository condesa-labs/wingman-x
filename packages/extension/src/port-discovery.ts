/**
 * Port discovery + caching for the local companion daemon.
 *
 * The daemon auto-bumps within the 53827–53836 range (spec §CP02). The
 * extension scans those ports on wake, caches the first `/health`-200
 * response in `chrome.storage.session` under `daemon_port`, and only
 * re-validates the cache when a `fetch` actually fails (spec §CP03).
 *
 * The module is intentionally isolated from Chrome APIs that are not
 * strictly needed so it can be called from any extension entrypoint
 * (background, popup, content script). The only external surfaces are
 * `chrome.storage.session` and `fetch`.
 */

export const STORAGE_KEY = "daemon_port";

/**
 * Use the numeric IPv4 loopback to avoid Happy Eyeballs (RFC 8305)
 * delays: Chrome tries ::1 first when resolving "localhost", and the
 * IPv6→IPv4 fallback often exceeds the 150 ms probe budget.
 */
export const DAEMON_HOST = "127.0.0.1";

export const PORT_RANGE: readonly number[] = Object.freeze([
  53827, 53828, 53829, 53830, 53831, 53832, 53833, 53834, 53835, 53836,
]);

/**
 * Per-port fetch timeout. Kept well under the 500 ms total budget so a
 * hung first port does not cascade into a slow popup.
 */
const PROBE_TIMEOUT_MS = 150;

export interface DiscoveryOptions {
  /** Override the range (tests inject a disjoint range). */
  range?: readonly number[];
  /** Override `fetch` (tests inject a stub). */
  fetchImpl?: typeof fetch;
  /** Override `chrome.storage.session` (tests inject an in-memory stub). */
  storage?: SessionStorageLike;
  /** Per-port timeout. Default 150 ms. */
  timeoutMs?: number;
  /**
   * Force a fresh scan even if another scan is in-flight. Used by
   * `invalidate_port` so an explicit invalidate does not inherit the
   * result of an older warm-up scan that started while the daemon was
   * still down (review-loop f10). The older scan is not cancelled; it
   * completes but its tail storage writes are skipped because a newer
   * generation has superseded it.
   */
  forceFresh?: boolean;
}

/**
 * Minimal shape of the `chrome.storage.session` API we depend on. Lets
 * us unit-test without `chrome-types` and swap for a mock.
 */
export interface SessionStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Default storage adapter that reads from `chrome.storage.session`. */
export function defaultStorage(): SessionStorageLike {
  return {
    get: (key) => chrome.storage.session.get(key),
    set: (items) => chrome.storage.session.set(items),
    remove: (key) => chrome.storage.session.remove(key),
  };
}

/**
 * Single-flight coalescing with generation tracking.
 *
 * Background:
 *   - Two concurrent invalidations (popup + content-script on the same
 *     daemon restart) share one scan → no race (review-loop f9).
 *   - A warm-up scan in-flight when an explicit invalidate arrives
 *     must NOT return the warm-up's stale result; the invalidate
 *     starts a fresh scan and the stale scan's tail cache-writes are
 *     skipped (review-loop f10).
 *
 * Mechanism:
 *   - `inflightScan` holds the current scan promise (if any).
 *   - `latestGeneration` is bumped at the start of every new scan.
 *   - When a scan's loop writes to storage, it checks that its own
 *     generation is still `latestGeneration`. An older scan whose
 *     generation has been superseded silently skips its storage
 *     `set`/`remove` call, leaving the newer scan's result untouched.
 *
 * Read paths (ensurePort → discoverPort without `forceFresh`) coalesce
 * with any in-flight scan. Explicit invalidate paths set
 * `forceFresh: true`, which starts a fresh generation.
 */
let inflightScan: Promise<number | null> | null = null;
let inflightIsFresh = false;
let latestGeneration = 0;

/**
 * Probe `range` in order and return the first port whose `/health`
 * endpoint replies 2xx with a daemon-shaped body. Caches the result
 * under `daemon_port`.
 *
 * Returns `null` when every port in the range is silent.
 *
 * Coalescing matrix (caller's `forceFresh` × inflight scan's fresh flag):
 *   ordinary  + ordinary inflight → coalesce (reuses scan result).
 *   ordinary  + fresh inflight    → coalesce (fresh is a stricter scan,
 *                                   ordinary accepts its result).
 *   fresh     + ordinary inflight → supersede; new fresh scan starts.
 *   fresh     + fresh inflight    → coalesce (peer-confirmed: two
 *                                   concurrent invalidations should
 *                                   share one scan — review-loop f11).
 */
export async function discoverPort(
  options: DiscoveryOptions = {},
): Promise<number | null> {
  const wantsFresh = options.forceFresh === true;

  // Short-circuit: share the in-flight scan when it's good enough for
  // this caller. "Good enough" means:
  //   - caller is ordinary → any in-flight scan is acceptable, OR
  //   - caller is fresh AND in-flight is also fresh → shared fresh scan.
  if (inflightScan !== null && (!wantsFresh || inflightIsFresh)) {
    return inflightScan;
  }

  latestGeneration += 1;
  const myGeneration = latestGeneration;
  const promise = doDiscoverPort(options, myGeneration).finally(() => {
    // Only clear module state if we are still the active scan. A newer
    // scan that replaced us has already overwritten inflightScan and
    // will clear it on its own completion.
    if (inflightScan === promise) {
      inflightScan = null;
      inflightIsFresh = false;
    }
  });
  inflightScan = promise;
  inflightIsFresh = wantsFresh;
  return promise;
}

/**
 * Generation-aware scan body. Returns the first daemon-shaped port it
 * finds (or null). Mutates `chrome.storage.session` ONLY when its own
 * generation is still the latest — an older scan whose generation has
 * been superseded by a forceFresh caller skips its writes so the new
 * scan's result stands.
 */
async function doDiscoverPort(
  options: DiscoveryOptions,
  myGeneration: number,
): Promise<number | null> {
  const range = options.range ?? PORT_RANGE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage ?? defaultStorage();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  for (const port of range) {
    if (await probe(port, fetchImpl, timeoutMs)) {
      if (myGeneration === latestGeneration) {
        await storage.set({ [STORAGE_KEY]: port });
      }
      return port;
    }
  }
  // Scan exhausted — drop any stale cached value to force a rescan
  // next call, but ONLY if no newer scan has superseded us.
  if (myGeneration === latestGeneration) {
    await storage.remove(STORAGE_KEY);
  }
  return null;
}

/**
 * Return the cached port, or `null` if nothing is cached.
 */
export async function getCachedPort(
  options: Pick<DiscoveryOptions, "storage"> = {},
): Promise<number | null> {
  const storage = options.storage ?? defaultStorage();
  const entry = await storage.get(STORAGE_KEY);
  const raw = entry[STORAGE_KEY];
  return typeof raw === "number" ? raw : null;
}

/**
 * Optimistic port resolver: returns cached port if present without
 * validating (key spec constraint — no eager re-validation). If nothing
 * is cached, falls back to a full scan.
 */
export async function ensurePort(
  options: DiscoveryOptions = {},
): Promise<number | null> {
  const cached = await getCachedPort({ storage: options.storage });
  if (cached !== null) return cached;
  return discoverPort(options);
}

/**
 * Issue a request against the daemon. If the cached port yields a
 * network error (e.g. daemon restarted on a new port), the cache is
 * invalidated and a fresh discovery pass runs once. On the second
 * failure the error propagates.
 *
 * Returns the first successful `Response` (including 4xx/5xx — those
 * are valid HTTP outcomes, only *transport* failures trigger rescan).
 */
export async function fetchWithPortRetry(
  path: string,
  init: RequestInit = {},
  options: DiscoveryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage ?? defaultStorage();

  const cached = await getCachedPort({ storage });
  if (cached !== null) {
    try {
      return await fetchImpl(`http://${DAEMON_HOST}:${cached}${path}`, init);
    } catch (err) {
      // Transport failure — drop cache and rescan ONCE.
      await storage.remove(STORAGE_KEY);
      // Preserve the original error to rethrow if the rescan also fails.
      const fresh = await discoverPort({ ...options, storage });
      if (fresh === null) throw err;
      return fetchImpl(`http://${DAEMON_HOST}:${fresh}${path}`, init);
    }
  }

  const fresh = await discoverPort({ ...options, storage });
  if (fresh === null) {
    throw new Error("daemon not running");
  }
  return fetchImpl(`http://${DAEMON_HOST}:${fresh}${path}`, init);
}

async function probe(
  port: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  // AbortController gives us a bounded per-port probe so one hung port
  // doesn't blow the whole 500 ms popup budget. Chrome's default fetch
  // timeout is effectively unbounded — we need this.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${DAEMON_HOST}:${port}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as unknown;
    return isDaemonHealthBody(body);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A 2xx `/health` from an unrelated local service on 53827–53836 would
 * poison the cache. We verify the body matches the daemon's contract
 * (`{ status: "ok", version: string }` — see
 * `packages/daemon/src/server.ts`'s `app.get("/health", ...)`). Any
 * deviation — non-JSON, wrong shape, wrong `status` — fails the probe.
 */
function isDaemonHealthBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const rec = body as Record<string, unknown>;
  return rec.status === "ok" && typeof rec.version === "string";
}
