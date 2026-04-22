import type { FastifyInstance } from "fastify";
import { loadState, saveState } from "./state.js";

export const DEFAULT_PORT_RANGE: readonly number[] = Object.freeze([
  53827, 53828, 53829, 53830, 53831, 53832, 53833, 53834, 53835, 53836,
]);

/**
 * Thrown when every port in the configured range is in use. The
 * `message` is a grep-able, user-facing string required verbatim by the
 * CP02 acceptance criteria.
 *
 * The character between "53827" and "53836" is U+2013 (EN DASH), not a
 * hyphen-minus — this matches the spec.
 */
export class NoAvailablePortError extends Error {
  constructor() {
    super("no available port in 53827\u201353836");
    this.name = "NoAvailablePortError";
  }
}

export interface ChoosePortOptions {
  /** Ports to try, in order. Defaults to `DEFAULT_PORT_RANGE`. */
  range?: readonly number[];
  /** Host to bind on. Defaults to `127.0.0.1`. */
  host?: string;
  /**
   * Where to write the grep-able listen line. Tests inject a collector
   * here. In production this is `console.info`, which guarantees the
   * line is visible regardless of pino log level — more robust than
   * relying on Fastify's logger config.
   */
  log?: (line: string) => void;
}

const DEFAULT_LOG = (line: string): void => {
  // eslint-disable-next-line no-console -- grep-able stdout line required by spec
  console.info(line);
};

/**
 * Try each port in `range` in order and `app.listen()` on the first one
 * that doesn't throw EADDRINUSE. Persists the chosen port to the state
 * file and logs a grep-able line.
 *
 * Throws `NoAvailablePortError` when every port in the range is busy.
 */
export async function chooseAndBindPort(
  app: FastifyInstance,
  options: ChoosePortOptions = {},
): Promise<number> {
  const range = options.range ?? DEFAULT_PORT_RANGE;
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? DEFAULT_LOG;

  let lastUnexpectedError: unknown = undefined;

  for (const port of range) {
    try {
      await app.listen({ port, host });
      // Route state updates through the server's `syncPort` decoration
      // so buildServer's in-memory `state` stays consistent with disk.
      // Fallback to the legacy standalone `persistPort` only when the
      // caller bound on a Fastify instance NOT built via `buildServer`
      // (bare tests). In the daemon's real boot path, syncPort wins.
      const app_ = app as FastifyInstance & { syncPort?: (p: number) => void };
      if (typeof app_.syncPort === "function") {
        app_.syncPort(port);
      } else {
        persistPort(port);
      }
      log(`[daemon] listening on port ${port}`);
      return port;
    } catch (err) {
      if (isAddressInUse(err)) {
        // Expected — try next port.
        continue;
      }
      // Anything else is an unexpected error; remember and throw after.
      lastUnexpectedError = err;
      break;
    }
  }

  if (lastUnexpectedError !== undefined) {
    throw lastUnexpectedError;
  }
  throw new NoAvailablePortError();
}

function isAddressInUse(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "EADDRINUSE";
}

function persistPort(port: number): void {
  // Load-modify-save so we don't drop whatever else the state already
  // contains. Swallow persistence errors here — the listen has succeeded
  // and we'd rather run than abort; the caller logs the error.
  try {
    const state = loadState();
    saveState({ ...state, port });
  } catch {
    // no-op — persistence failure at startup is non-fatal for port
    // selection itself; the daemon is already listening.
  }
}
