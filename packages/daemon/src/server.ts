import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import {
  ActionBodySchema,
  CandidateSchema,
  PostCandidatesBodySchema,
  SuggestionQuerySchema,
  type Candidate,
  type CandidateInput,
} from "./schemas.js";
import {
  candidatesList,
  loadState,
  saveState,
} from "./state.js";

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
 * Parse `TWITTER_HELPER_EXT_ALLOWED_IDS` (comma-separated). When set,
 * the daemon only echoes ACAO for `chrome-extension://` origins whose
 * ID is in the list — closing the peer's f4 concern that "every
 * installed extension passes the format check". When unset, any
 * canonical 32-char [a-p] ID is accepted, preserving unpacked-dev
 * flexibility (unpacked IDs change across machines/workspaces).
 *
 * Production deployments should set this to the single Chrome Web
 * Store ID once the extension ships. Dev workflows leave it unset.
 */
function extAllowList(): ReadonlySet<string> | null {
  const raw = process.env.TWITTER_HELPER_EXT_ALLOWED_IDS;
  if (!raw || raw.trim().length === 0) return null;
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

  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin or tools like curl send no Origin → allow.
      if (!origin) return cb(null, true);
      if (CONTENT_SCRIPT_PAGE_ORIGIN.test(origin)) {
        return cb(null, true);
      }
      if (CHROME_EXT_ORIGIN.test(origin)) {
        // When TWITTER_HELPER_EXT_ALLOWED_IDS is set, pin to that
        // specific list; otherwise allow any canonical extension ID
        // for dev convenience. The pinning option is the mitigation
        // for f4's "every installed extension passes" class of attack.
        const allow = extAllowList();
        if (allow === null) return cb(null, true);
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
    for (const input of parsed.data.candidates) {
      const existing = state.candidates[input.tweet_id];
      const merged = mergeCandidate(existing, input, now);
      state.candidates[input.tweet_id] = merged;
      stored += 1;
    }

    try {
      saveState(state);
    } catch (err) {
      req.log?.error({ err }, "failed to persist state");
      return reply.code(500).send({ error: "persistence_failure" });
    }

    return { stored };
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

  return app;
}

function invalidRequest(err: ZodError): {
  error: string;
  details: Array<{ path: (string | number)[]; message: string }>;
} {
  return {
    error: "invalid_request",
    details: err.issues.map((i) => ({ path: i.path, message: i.message })),
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

// Prevent `z` unused-import warning if tree-shaking misses it.
void z;
