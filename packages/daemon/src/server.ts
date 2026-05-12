import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import { randomUUID } from "node:crypto";
import {
  ActionBodySchema,
  CandidateSchema,
  ObservedTweetSchema,
  PostCandidatesBodySchema,
  PostObservedTweetsBodySchema,
  SignalInputSchema,
  SignalSchema,
  SignalsQuerySchema,
  SuggestionQuerySchema,
  TweetPoolTopQuerySchema,
  type Candidate,
  type CandidateInput,
  type ObservedTweet,
  type Signal,
  type StateFile,
} from "./schemas.js";
import {
  candidatesList,
  loadState,
  saveState,
} from "./state.js";
import { EventBus } from "./events.js";
import { Readable } from "node:stream";
import { computeScore, computeNoveltyBonus, type NoveltyContext } from "./score.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Update the server's in-memory state with the bound port AND persist
     * through the same state reference the handlers save on mutation.
     * Called by `chooseAndBindPort` after a successful listen so a later
     * `POST /candidates` does not overwrite `state.json` with a port-less
     * snapshot (the symptom of the review-loop f1 regression).
     */
    syncPort: (port: number) => void;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8"),
) as { version: string };

export interface BuildServerOptions {
  /**
   * Port to expose on `/config`. Does NOT trigger a listen — the HTTP
   * listen is handled by the entrypoint. This value is persisted to the
   * state file when the server starts.
   */
  port?: number;
  logger?: boolean;
  now?: () => Date;
  onTweetPoolEviction?: () => void;
}

/**
 * Every response carries this header so callers on the same machine
 * can distinguish us from a co-located service squatting on the
 * daemon's auto-bumped port range (review-loop f14). The header is
 * exposed via CORS `exposedHeaders` so browser JS can read it
 * regardless of which endpoint or status code returned.
 */
export const DAEMON_HEADER = "x-twitter-helper-daemon";

/**
 * Matches the canonical `chrome-extension://<id>` format. Chrome
 * production / unpacked extension IDs are always 32 characters in the
 * `[a-p]` alphabet (derived from a SHA-256 hash of the extension's
 * key, folded to 4 bits per character). By itself, this regex only
 * rejects syntactically-invalid origins — any INSTALLED extension
 * with localhost host permissions would pass. See `extAllowList()`
 * below for the environment-variable-driven ID pinning that closes
 * the "trust any chrome-extension" gap in review-loop f4.
 */
const CHROME_EXT_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/**
 * Parse `TWITTER_HELPER_EXT_ALLOWED_IDS` (comma-separated). Return
 * value distinguishes three states:
 *
 *   - `undefined` → env var was never set. Dev default: any canonical
 *     32-char [a-p] chrome-extension:// ID is accepted. Preserves
 *     unpacked-dev flexibility (unpacked IDs vary per machine).
 *   - `Set<string>` (possibly empty) → env var was explicitly set.
 *     Daemon ONLY echoes ACAO for extension IDs in the set. An
 *     **empty** set (env var = `""` or whitespace) means REJECT ALL
 *     chrome-extension origins — fail-closed on config mistakes
 *     like a blank-but-present secret, a templating glitch, or an
 *     un-expanded env reference (review-loop final-consensus-v5).
 *
 * Production deployments should set this to the single Chrome Web
 * Store ID once the extension ships.
 */
function extAllowList(): ReadonlySet<string> | undefined {
  const raw = process.env.TWITTER_HELPER_EXT_ALLOWED_IDS;
  if (raw === undefined) return undefined;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Content-scripts inherit their host page's origin for CORS, so the
 * daemon must also allow the pages the extension is active on:
 * production twitter.com / x.com and E2E-test localhost fixtures.
 * (Extension contexts — popup, background — are covered by
 * CHROME_EXT_ORIGIN above.) The old regex `/^http:\/\/localhost/` was
 * reviewed in f4; narrowing to ONLY localhost still permitted any
 * local web app to hit the daemon via browser CORS. The production
 * tweet origins don't expand attack surface meaningfully — any script
 * running on twitter.com can already fetch anything the user can.
 */
const CONTENT_SCRIPT_PAGE_ORIGIN =
  /^(?:https:\/\/(?:www\.)?(?:twitter|x)\.com|http:\/\/localhost(?::\d+)?)$/i;

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger === true });
  const now = options.now ?? (() => new Date());

  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin or tools like curl send no Origin → allow.
      if (!origin) return cb(null, true);
      if (CONTENT_SCRIPT_PAGE_ORIGIN.test(origin)) {
        return cb(null, true);
      }
      if (CHROME_EXT_ORIGIN.test(origin)) {
        // Three states for TWITTER_HELPER_EXT_ALLOWED_IDS:
        //   - undefined (unset) → dev default, accept any canonical ID.
        //   - non-empty Set     → pin, accept only listed IDs.
        //   - empty Set         → fail-closed, reject all extensions
        //                         (env was set but empty — probably a
        //                         config/templating mistake).
        const allow = extAllowList();
        if (allow === undefined) return cb(null, true);
        const id = origin.substring("chrome-extension://".length);
        return cb(null, allow.has(id));
      }
      // Fail-soft: do NOT throw, just return false so the response lacks
      // the ACAO header. Disallowed origins still get a 204 on OPTIONS
      // (standard behaviour) — the browser enforces the block.
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["content-type"],
    exposedHeaders: [DAEMON_HEADER],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Stamp every response — including errors and 4xx/5xx — with the
  // daemon-identity header. This lets clients detect stale-cache
  // scenarios (another local service squatting on our port) uniformly,
  // regardless of status code (review-loop f14).
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header(DAEMON_HEADER, pkg.version);
    return payload;
  });

  // Load persisted state once at build time. All mutation methods below
  // operate on this in-memory copy and re-persist via saveState(). We
  // only ever MUTATE `state` (never reassign) so every handler and
  // `syncPort` below share the same object reference.
  const state = loadState();

  // In-process event bus. The /events SSE route subscribes; POST
  // handlers publish. Single-process Fastify = no distributed pubsub.
  const events = new EventBus();
  if (options.port !== undefined) {
    state.port = options.port;
    // Don't save here — the main entrypoint saves state after a
    // successful listen so we don't write a port that failed to bind.
  }

  app.decorate("syncPort", (port: number) => {
    state.port = port;
    try {
      saveState(state);
    } catch {
      // Listen has already succeeded; a persistence failure here is
      // non-fatal — the daemon runs, it just won't recall the port on
      // the next boot. Matches the contract of `port.persistPort`
      // which this decoration replaces.
    }
  });

  app.get("/health", async () => ({ status: "ok", version: pkg.version }));

  app.get("/candidates", async () => ({
    candidates: candidatesList(state),
  }));

  app.post("/candidates", async (req, reply) => {
    const parsed = PostCandidatesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }

    const now = new Date().toISOString();
    let stored = 0;
    // Track which incoming candidates are NEW (not already in state) —
    // only those trigger candidate_added events. Re-POSTs / redrafts
    // update suggested_reply without notifying; the pool already knew
    // about that tweet_id.
    const newlyAdded: Array<{
      tweet_id: string;
      author_handle: string;
      match_category: "selected" | "topic" | "trending" | "explore";
    }> = [];
    for (const input of parsed.data.candidates) {
      const existing = state.candidates[input.tweet_id];
      const merged = mergeCandidate(existing, input, now);
      state.candidates[input.tweet_id] = merged;
      stored += 1;
      if (existing === undefined) {
        newlyAdded.push({
          tweet_id: merged.tweet_id,
          author_handle: merged.author_handle,
          match_category: merged.match_category,
        });
      }
    }

    try {
      saveState(state);
    } catch (err) {
      req.log?.error({ err }, "failed to persist state");
      return reply.code(500).send({ error: "persistence_failure" });
    }

    // Publish AFTER successful persist so subscribers never see events
    // for candidates that didn't actually survive to disk.
    for (const nc of newlyAdded) {
      events.publish({
        type: "candidate_added",
        tweet_id: nc.tweet_id,
        author_handle: nc.author_handle,
        match_category: nc.match_category,
      });
    }

    return { stored };
  });

  app.post("/tweets/observed", async (req, reply) => {
    const parsed = PostObservedTweetsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }

    const observedAt = now().toISOString();
    for (const input of parsed.data.tweets) {
      const observed = ObservedTweetSchema.parse({
        ...input,
        observed_at: observedAt,
        score: computeScore(input, new Date(observedAt)),
      });
      state.tweet_pool[observed.tweet_id] = observed;
    }
    evictTweetPool(state.tweet_pool, new Date(observedAt));
    options.onTweetPoolEviction?.();

    try {
      saveState(state);
    } catch (err) {
      req.log?.error({ err }, "failed to persist state");
      return reply.code(500).send({ error: "persistence_failure" });
    }

    return { stored: parsed.data.tweets.length };
  });

  app.get("/tweet_pool/top", async (req, reply) => {
    const parsed = TweetPoolTopQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }
    const { limit, min_score } = parsed.data;

    const noveltyCtx = buildNoveltyContext(state);
    const ranked = Object.values(state.tweet_pool)
      .filter((tweet) => tweet.score >= min_score)
      .map((tweet) => ({
        ...tweet,
        _effectiveScore:
          tweet.score +
          computeNoveltyBonus(tweet.author_handle, noveltyCtx),
      }))
      .sort((a, b) => {
        const byScore = b._effectiveScore - a._effectiveScore;
        if (byScore !== 0) return byScore;
        const byObserved = b.observed_at.localeCompare(a.observed_at);
        if (byObserved !== 0) return byObserved;
        return a.tweet_id.localeCompare(b.tweet_id);
      })
      .slice(0, limit)
      .map(({ _effectiveScore, ...tweet }) => tweet);

    return { tweets: ranked };
  });

  /**
   * SSE endpoint for live candidate events.
   *
   * Clients (extension background SW, future dashboards) open an
   * EventSource against this URL and receive `data: <json>\n\n` frames
   * whenever a new candidate is added via POST /candidates.
   *
   * Heartbeat comment frames (":heartbeat\n\n") every 20s keep the
   * connection alive through idle proxies and let the client detect a
   * dead socket within one heartbeat interval. SSE comments (lines
   * starting with ":") are not delivered to EventSource message
   * handlers, so they don't pollute app-level events.
   */
  app.get("/events", async (req, reply) => {
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache, no-transform");
    reply.header("X-Accel-Buffering", "no");
    // CORS headers are already applied by @fastify/cors's preHandler
    // before this runs; the stream-send path below preserves them.

    const stream = new Readable({ read() {} });

    const unsubscribe = events.subscribe((frame) => stream.push(frame));

    const heartbeat = setInterval(() => {
      stream.push(":heartbeat\n\n");
    }, 20_000);

    // Tear down on client disconnect. Both `req.raw.close` (TCP close)
    // and stream consumer pause paths converge here.
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      stream.push(null);
    });

    // Initial frame so EventSource's `onopen` fires promptly. Comment
    // line — not a `data:` frame — so it doesn't deliver a phantom
    // message on connect.
    stream.push(":ok\n\n");

    return reply.send(stream);
  });

  app.get("/suggestion", async (req, reply) => {
    const parsed = SuggestionQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }
    const cand = state.candidates[parsed.data.tweet_id];
    if (!cand) {
      return reply.code(404).send({ error: "not_found" });
    }
    return cand;
  });

  app.post<{ Params: { id: string } }>(
    "/candidates/:id/action",
    async (req, reply) => {
      const id = req.params.id;
      const parsed = ActionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest(parsed.error));
      }
      const cand = state.candidates[id];
      if (!cand) {
        return reply.code(404).send({ error: "not_found" });
      }

      const nextStatus = parsed.data.action;
      const now = new Date().toISOString();
      const updated: Candidate = {
        ...cand,
        status: nextStatus,
        status_updated_at: now,
      };
      state.candidates[id] = updated;

      try {
        saveState(state);
      } catch (err) {
        req.log?.error({ err }, "failed to persist state");
        return reply.code(500).send({ error: "persistence_failure" });
      }

      return updated;
    },
  );

  app.get("/config", async () => ({
    port: state.port,
    kb_dir: state.config.kb_dir,
  }));

  /**
   * Pull-signal endpoints. The extension POSTs a `discovery_requested`
   * when the user clicks the popup's "Request discovery" button; the
   * agent's skill GETs pending signals on session start, acts, then
   * POSTs /ack. Signal lifecycle is deliberately 2-state (pending →
   * acked) — simpler than candidate's 5-state flow because there is no
   * user-facing interaction besides "create" and "consume".
   */
  app.post("/signals", async (req, reply) => {
    const parsed = SignalInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }

    const now = new Date().toISOString();
    const signal: Signal = SignalSchema.parse({
      id: randomUUID(),
      kind: parsed.data.kind,
      status: "pending",
      meta: parsed.data.meta,
      created_at: now,
    });
    state.signals[signal.id] = signal;

    try {
      saveState(state);
    } catch (err) {
      req.log?.error({ err }, "failed to persist state");
      return reply.code(500).send({ error: "persistence_failure" });
    }

    events.publish({
      type: "signal_added",
      id: signal.id,
      kind: signal.kind,
      created_at: signal.created_at,
    });

    return signal;
  });

  app.get("/signals", async (req, reply) => {
    const parsed = SignalsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }
    const { kind, status, limit, cursor } = parsed.data;
    const signals = Object.values(state.signals).filter((s) => {
      if (kind && s.kind !== kind) return false;
      if (status && s.status !== status) return false;
      return true;
    }).sort((a, b) => {
      const byCreated = a.created_at.localeCompare(b.created_at);
      return byCreated === 0 ? a.id.localeCompare(b.id) : byCreated;
    });

    let start = 0;
    if (cursor) {
      const cursorIndex = signals.findIndex((s) => s.id === cursor);
      if (cursorIndex === -1) {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
      start = cursorIndex + 1;
    }

    const page = signals.slice(start, start + limit);
    const hasNext = start + limit < signals.length;
    return {
      signals: page,
      ...(hasNext ? { nextCursor: page[page.length - 1]?.id } : {}),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/signals/:id/ack",
    async (req, reply) => {
      const id = req.params.id;
      const signal = state.signals[id];
      if (!signal) {
        return reply.code(404).send({ error: "not_found" });
      }
      // Idempotent: re-acking an already-acked signal is a no-op that
      // returns the existing record. Agents re-running discovery
      // shouldn't 409 on a duplicate ack.
      if (signal.status === "acked") {
        return signal;
      }
      const updated: Signal = {
        ...signal,
        status: "acked",
        acked_at: new Date().toISOString(),
      };
      state.signals[id] = updated;

      try {
        saveState(state);
      } catch (err) {
        req.log?.error({ err }, "failed to persist state");
        return reply.code(500).send({ error: "persistence_failure" });
      }

      return updated;
    },
  );

  return app;
}

function loadTier1Handles(): ReadonlySet<string> {
  const handlesPath = resolve(
    homedir(),
    ".twitter-helper/kb/selected-handles.txt",
  );
  if (!existsSync(handlesPath)) return new Set();
  const text = readFileSync(handlesPath, "utf-8");
  const handles = new Set<string>();
  let inTier1 = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## Tier 1")) {
      inTier1 = true;
      continue;
    }
    if (trimmed.startsWith("## Tier 2")) break;
    if (!inTier1) continue;
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;
    handles.add(trimmed.toLowerCase());
  }
  return handles;
}

let _tier1Cache: ReadonlySet<string> | null = null;
function getTier1Handles(): ReadonlySet<string> {
  if (_tier1Cache === null) _tier1Cache = loadTier1Handles();
  return _tier1Cache;
}

function buildNoveltyContext(state: StateFile): NoveltyContext {
  const candidateHandles = new Set<string>(
    Object.values(state.candidates).map((c: Candidate) => c.author_handle.toLowerCase()),
  );
  return { tier1Handles: getTier1Handles(), candidateHandles };
}

function invalidRequest(err: ZodError): {
  error: string;
  details: Array<{ path: (string | number)[]; message: string }>;
} {
  return {
    error: "invalid_request",
    details: err.issues.map((i) => ({
      path: i.path.map((p) => (typeof p === "symbol" ? p.toString() : p)),
      message: i.message,
    })),
  };
}

/**
 * Merge logic:
 * - If no prior candidate: fill server-managed fields (created_at,
 *   status, status_updated_at) with defaults if the caller omitted them.
 * - If prior exists: latest-wins on every user field, but:
 *     - `created_at` is PRESERVED from the existing record. An agent
 *       cannot rewrite history.
 *     - `status` & `status_updated_at` are PRESERVED from the existing
 *       record. Only the `POST /:id/action` endpoint transitions status.
 *       This ensures a re-POST with the same tweet_id doesn't
 *       accidentally resurrect a dismissed candidate to `pending`.
 */
function mergeCandidate(
  existing: Candidate | undefined,
  input: CandidateInput,
  now: string,
): Candidate {
  if (!existing) {
    const candidate: Candidate = {
      ...input,
      kb_refs: input.kb_refs ?? [],
      created_at: input.created_at ?? now,
      status: input.status ?? "pending",
      status_updated_at: input.status_updated_at ?? now,
    };
    // Defensive re-parse so server-side guarantees hold.
    return CandidateSchema.parse(candidate);
  }

  const merged: Candidate = {
    ...input,
    kb_refs: input.kb_refs ?? existing.kb_refs,
    created_at: existing.created_at,
    status: existing.status,
    status_updated_at: existing.status_updated_at,
  };
  return CandidateSchema.parse(merged);
}

const TWEET_POOL_TTL_MS = 24 * 60 * 60 * 1000;
const TWEET_POOL_CAPACITY = 1000;

function evictTweetPool(
  pool: Record<string, ObservedTweet>,
  now: Date,
): void {
  const cutoff = now.getTime() - TWEET_POOL_TTL_MS;
  for (const [tweetId, tweet] of Object.entries(pool)) {
    if (Date.parse(tweet.observed_at) < cutoff) {
      delete pool[tweetId];
    }
  }

  const entries = Object.values(pool);
  if (entries.length <= TWEET_POOL_CAPACITY) return;

  const keep = new Set(
    entries
      .sort(compareTweetPoolEntries)
      .slice(0, TWEET_POOL_CAPACITY)
      .map((tweet) => tweet.tweet_id),
  );
  for (const tweetId of Object.keys(pool)) {
    if (!keep.has(tweetId)) {
      delete pool[tweetId];
    }
  }
}

function compareTweetPoolEntries(a: ObservedTweet, b: ObservedTweet): number {
  const byScore = b.score - a.score;
  if (byScore !== 0) return byScore;
  const byObserved = b.observed_at.localeCompare(a.observed_at);
  if (byObserved !== 0) return byObserved;
  return a.tweet_id.localeCompare(b.tweet_id);
}

// Prevent `z` unused-import warning if tree-shaking misses it.
void z;
