import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StateFileSchema, type Candidate, type StateFile } from "./schemas.js";

export const DEFAULT_STATE_SUBDIR = ".wingman-x";
export const STATE_FILE_NAME = "state.json";

/**
 * Resolve the state directory.
 * - If `WINGMAN_X_STATE_DIR` is set, use that verbatim (used by
 *   tests to avoid clobbering `~/.wingman-x/state.json`).
 * - Otherwise, default to `~/.wingman-x`.
 *
 * This env var is shared with the KB layer (`@wingman-x/adapter-fs`
 * and `@wingman-x/agent-kit`) so a single value controls where the
 * daemon's `state.json` and the KB cache live.
 */
export function resolveStateDir(): string {
  const override = process.env.WINGMAN_X_STATE_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), DEFAULT_STATE_SUBDIR);
}

export function resolveStatePath(): string {
  return join(resolveStateDir(), STATE_FILE_NAME);
}

/**
 * Read state from disk. Returns an empty state if the file is missing or
 * malformed. The daemon should NEVER crash on a bad state file — that
 * would leave the user unable to start the daemon. A corrupt state file
 * is treated as "no state yet".
 */
export function loadState(): StateFile {
  const path = resolveStatePath();
  if (!existsSync(path)) {
    return emptyState();
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = StateFileSchema.safeParse(parsed);
    if (!result.success) {
      return emptyState();
    }
    return result.data;
  } catch {
    return emptyState();
  }
}

/**
 * Atomically persist state to disk:
 *   1. ensure parent dir exists
 *   2. write JSON to `<statePath>.tmp`
 *   3. fsync the tmp file
 *   4. rename(tmp → statePath) — atomic on POSIX.
 *
 * If step 2, 3, or 4 throws, the existing `state.json` is unchanged.
 * Callers should treat the thrown error as a persistence failure.
 */
export function saveState(state: StateFile): void {
  const path = resolveStatePath();
  const dir = dirname(path);
  const tmpPath = `${path}.tmp`;

  mkdirSync(dir, { recursive: true });

  const serialised = `${JSON.stringify(state, null, 2)}\n`;

  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, serialised);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Atomic replace. Rename is the atomic step; if it throws, the prior
  // state.json is left intact.
  renameSync(tmpPath, path);
}

/**
 * Write state without the atomic rename — used exclusively in tests to
 * seed a state file directly. Not exported from index.
 */
export function writeStateDirect(state: StateFile): void {
  const path = resolveStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function emptyState(): StateFile {
  return {
    candidates: {},
    signals: {},
    tweet_pool: {},
    config: { kb_dir: join(homedir(), DEFAULT_STATE_SUBDIR, "kb") },
  };
}

export function candidatesList(state: StateFile): Candidate[] {
  return Object.values(state.candidates);
}
