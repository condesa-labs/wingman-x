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
 * Matches `chrome-extension://<id>` — Chrome extension ids are 32
 * lowercase letters in production but unpacked ids are often shorter /
 * include digits, so we allow `[a-z0-9]+` to cover both.
 */
const CHROME_EXT_ORIGIN = /^chrome-extension:\/\/[a-z0-9]+$/i;
const LOCALHOST_ORIGIN = /^http:\/\/localhost(:\d+)?$/i;

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger === true });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin or tools like curl send no Origin → allow.
      if (!origin) return cb(null, true);
      if (CHROME_EXT_ORIGIN.test(origin) || LOCALHOST_ORIGIN.test(origin)) {
        return cb(null, true);
      }
      // Fail-soft: do NOT throw, just return false so the response lacks
      // the ACAO header. Disallowed origins still get a 204 on OPTIONS
      // (standard behaviour) — the browser enforces the block.
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["content-type"],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Load persisted state once at build time. All mutation methods below
  // operate on this in-memory copy and re-persist via saveState().
  let state = loadState();
  if (options.port !== undefined) {
    state = { ...state, port: options.port };
    // Don't save here — the main entrypoint saves state after a
    // successful listen so we don't write a port that failed to bind.
  }

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
