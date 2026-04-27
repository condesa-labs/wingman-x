import {
  CandidateSchema,
  type Candidate,
  type CandidateInput,
} from "./candidate.js";
import {
  SignalSchema,
  SignalsListResponseSchema,
  type Signal,
  type SignalInput,
  type SignalsQuery,
} from "./signal.js";
import {
  DaemonHttpError,
  DaemonNetworkError,
  DaemonTimeoutError,
} from "./errors.js";

/**
 * Actions the daemon accepts on `POST /candidates/:id/action`. The
 * canonical list lives in `packages/daemon/src/schemas.ts#ActionEnum`.
 *
 * The prompt spec only called out three actions
 * (`'filled' | 'dismissed' | 'regen_requested'`), but the daemon has
 * accepted a fourth — `'saved'` — since CP02. Omitting it would leave
 * agents unable to mark a candidate as saved, i.e. would hobble the
 * very client this package is for. We include all four and note the
 * rule-conflict in output-summary.md.
 */
export type DaemonAction =
  | "filled"
  | "dismissed"
  | "saved"
  | "regen_requested";

export interface DaemonClientOptions {
  /**
   * Per-request timeout in milliseconds. After this elapses the
   * underlying `AbortController` fires and the method rejects with
   * `DaemonTimeoutError`. Single-attempt semantics — the client does
   * not retry.
   */
  timeoutMs?: number;
  /**
   * Injectable `fetch` for tests. Defaults to `globalThis.fetch`, which
   * is available in Node 20+ (the repo's `engines.node` minimum).
   */
  fetch?: typeof fetch;
}

export interface DaemonClient {
  postCandidates(cs: CandidateInput[]): Promise<{ accepted: number }>;
  getCandidates(): Promise<Candidate[]>;
  postAction(id: string, action: DaemonAction): Promise<void>;
  getConfig(): Promise<{ kb_dir: string; port: number }>;
  /**
   * Pull-signal surface. The extension's "Request discovery" button
   * fires `postSignal({ kind: "discovery_requested" })`; the agent's
   * discover skill runs `listSignals({ kind: "discovery_requested",
   * status: "pending" })` on start-up and `ackSignal(id)` after handling
   * the run.
   */
  postSignal(input: SignalInput): Promise<Signal>;
  listSignals(query?: SignalsQuery): Promise<Signal[]>;
  ackSignal(id: string): Promise<Signal>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Construct a thin typed HTTP client around the daemon's REST surface.
 *
 * Design choices:
 *   - Single attempt. No retry loops. Callers decide if / how to retry
 *     based on the typed error they catch; that's the discipline the
 *     spec's acceptance criteria require (`no infinite retry`).
 *   - `AbortController` per request, not per client — so a slow request
 *     doesn't poison a subsequent fast one.
 *   - Errors are fully typed (`DaemonHttpError` / `DaemonTimeoutError`
 *     / `DaemonNetworkError`). Callers can `switch (err.name)` or use
 *     `instanceof`.
 *   - `getCandidates` validates the server response with zod so a
 *     server-side schema drift surfaces as a loud throw rather than a
 *     silent shape mismatch at the agent layer. This is the coverage
 *     of the spec's "assert shape match" acceptance criterion for the
 *     integration test.
 */
export function createDaemonClient(
  port: number,
  opts: DaemonClientOptions = {},
): DaemonClient {
  const baseUrl = `http://localhost:${port}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Bind lazily so we pick up the injected fetch at call time; this
  // also matters when the caller stubs out globalThis.fetch in a test
  // harness.
  const doFetch: typeof fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err, controller)) {
        throw new DaemonTimeoutError(timeoutMs);
      }
      throw new DaemonNetworkError(err);
    } finally {
      clearTimeout(timer);
    }
  };

  const expectOk = async (res: Response): Promise<Response> => {
    if (res.ok) return res;
    const body = await readBody(res);
    throw new DaemonHttpError(res.status, res.statusText, body);
  };

  return {
    async postCandidates(cs) {
      const res = await request("/candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidates: cs }),
      });
      await expectOk(res);
      // Daemon returns `{ stored: number }` (see
      // packages/daemon/src/server.ts); we surface that to callers as
      // `accepted` because the spec calls out "accepted count" and
      // "accepted" is the semantically correct name at this layer.
      const parsed = (await res.json()) as { stored?: number };
      return { accepted: parsed.stored ?? 0 };
    },

    async getCandidates() {
      const res = await request("/candidates");
      await expectOk(res);
      const parsed = (await res.json()) as { candidates?: unknown[] };
      const list = parsed.candidates ?? [];
      // Validate each candidate. This is deliberately strict: a
      // schema drift at the daemon side should fail loudly on the
      // client rather than flowing corrupt data to the agent.
      return list.map((c) => CandidateSchema.parse(c));
    },

    async postAction(id, action) {
      const res = await request(
        `/candidates/${encodeURIComponent(id)}/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      await expectOk(res);
      // Daemon returns the updated Candidate, but the spec's typed
      // surface returns `void` — agents that want the updated record
      // can call `getCandidates()` or `GET /suggestion` instead. Keeps
      // the method's return type stable.
      return;
    },

    async getConfig() {
      const res = await request("/config");
      await expectOk(res);
      const parsed = (await res.json()) as { port?: number; kb_dir?: string };
      return {
        port: parsed.port ?? 0,
        kb_dir: parsed.kb_dir ?? "",
      };
    },

    async postSignal(input) {
      const res = await request("/signals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await expectOk(res);
      return SignalSchema.parse(await res.json());
    },

    async listSignals(query = {}) {
      const qs = new URLSearchParams();
      if (query.kind) qs.set("kind", query.kind);
      if (query.status) qs.set("status", query.status);
      if (query.limit !== undefined) qs.set("limit", String(query.limit));
      if (query.cursor) qs.set("cursor", query.cursor);
      const suffix = qs.toString();
      const res = await request(`/signals${suffix ? `?${suffix}` : ""}`);
      await expectOk(res);
      return SignalsListResponseSchema.parse(await res.json()).signals;
    },

    async ackSignal(id) {
      const res = await request(`/signals/${encodeURIComponent(id)}/ack`, {
        method: "POST",
      });
      await expectOk(res);
      return SignalSchema.parse(await res.json());
    },
  };
}

/**
 * Distinguishes a timeout-driven abort (our own AbortController fired)
 * from any other error. We check the `AbortError` name OR the
 * controller's signal — fetch implementations are inconsistent here:
 *   - Node's undici throws `DOMException` with `name === 'AbortError'`.
 *   - Mocks commonly throw a plain Error with `name === 'AbortError'`.
 *   - Some wrap-around layers throw a TypeError and just set
 *     `signal.aborted`.
 * We cover both paths.
 */
function isAbortError(err: unknown, controller: AbortController): boolean {
  if (controller.signal.aborted) return true;
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (name === "AbortError") return true;
  }
  return false;
}

/**
 * Read a response body in whichever form the server sent — JSON if the
 * Content-Type says so, otherwise plain text. We don't throw on malformed
 * JSON because the point of capturing the body is to give the caller as
 * much diagnostic detail as possible, not to re-validate it.
 */
async function readBody(res: Response): Promise<unknown> {
  // We read the raw text first and then attempt a JSON parse if the
  // server claims `application/json`. Calling `res.json()` first would
  // consume the body and leave `res.text()` with nothing to fall back
  // to, so we avoid that two-attempt-on-one-body pitfall.
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      // Malformed JSON — drop through and return the raw text, which
      // is more useful to the caller than a JSON SyntaxError.
    }
  }
  return text;
}
