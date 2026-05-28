import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create an isolated temp state directory for a test and register cleanup.
 * Sets `WINGMAN_X_STATE_DIR` so the daemon reads/writes there instead
 * of `~/.wingman-x` — this prevents tests from clobbering the real
 * user state.
 */
export function setupTempStateDir(): {
  dir: string;
  statePath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "wingman-x-test-"));
  const previous = process.env.WINGMAN_X_STATE_DIR;
  process.env.WINGMAN_X_STATE_DIR = dir;
  return {
    dir,
    statePath: join(dir, "state.json"),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      if (previous === undefined) {
        delete process.env.WINGMAN_X_STATE_DIR;
      } else {
        process.env.WINGMAN_X_STATE_DIR = previous;
      }
    },
  };
}

export function sampleCandidate(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "uuid-1",
    tweet_id: "1790000000000000001",
    tweet_url: "https://x.com/alice_ai/status/1790000000000000001",
    author_handle: "@alice_ai",
    tweet_text: "Hot take on agents.",
    suggested_reply: "Agree — autonomy matters.",
    match_reason: "matches topic:agents in KB",
    match_category: "topic",
    kb_refs: ["library/agents.md"],
    ...overrides,
  };
}
