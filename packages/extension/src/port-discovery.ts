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
 * Probe `range` in order and return the first port whose `/health`
 * endpoint replies 2xx. Caches the result under `daemon_port`.
 *
 * Returns `null` when every port in the range is silent.
 */
export async function discoverPort(
  options: DiscoveryOptions = {},
): Promise<number | null> {
  const range = options.range ?? PORT_RANGE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage ?? defaultStorage();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  for (const port of range) {
    if (await probe(port, fetchImpl, timeoutMs)) {
      await storage.set({ [STORAGE_KEY]: port });
      return port;
    }
  }
  // Scan exhausted — drop any stale cached value to force a rescan next call.
  await storage.remove(STORAGE_KEY);
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
      return await fetchImpl(`http://localhost:${cached}${path}`, init);
    } catch (err) {
      // Transport failure — drop cache and rescan ONCE.
      await storage.remove(STORAGE_KEY);
      // Preserve the original error to rethrow if the rescan also fails.
      const fresh = await discoverPort({ ...options, storage });
      if (fresh === null) throw err;
      return fetchImpl(`http://localhost:${fresh}${path}`, init);
    }
  }

  const fresh = await discoverPort({ ...options, storage });
  if (fresh === null) {
    throw new Error("daemon not running");
  }
  return fetchImpl(`http://localhost:${fresh}${path}`, init);
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
    const res = await fetchImpl(`http://localhost:${port}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
