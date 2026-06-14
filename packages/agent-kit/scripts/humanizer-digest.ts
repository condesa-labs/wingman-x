#!/usr/bin/env tsx
/**
 * humanizer-digest.ts — HUMAN-RUN feedback digest tool. Reads the local
 * `<stateDir>/flagged-replies.jsonl` (written by the watcher), renders a
 * markdown digest of AI-tell patterns, and prints a ready-to-run
 * `gh issue create` command. Run as
 * `npm --workspace @wingman-x/agent-kit run humanizer-digest`.
 *
 * Architecture (concise, mirrors scripts/watcher.ts):
 *   1. Resolve `<stateDir>` via the WINGMAN_X_STATE_DIR helper (no hardcoded
 *      ~). Read flagged-replies.jsonl (missing/empty file is fine).
 *   2. Render the digest from the PURE core in src/humanizer-digest-core.ts.
 *   3. Print the digest + the ready-to-run `gh issue create` command.
 *   4. ONLY when `--post` is passed do we actually invoke `gh` (child_process)
 *      to open the issue. The default run performs NO network call.
 *
 * Why is the testable logic in src/humanizer-digest-core.ts?
 *   Vitest's coverage scope is `src/**`. This file is thin I/O wiring (file
 *   read + optional `gh` spawn) and is deliberately out of the coverage gate;
 *   all branchy parse/aggregate/render logic lives in the core.
 */
import "../../../scripts/load-env.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderDigest } from "../src/humanizer-digest-core.js";
import { resolveWingmanXStateDir } from "../src/kb-paths.js";

const FLAGGED_REPLIES_LOG_FILE = "flagged-replies.jsonl";
const ISSUE_TITLE = "Humanizer feedback digest";

function readLog(logPath: string): string {
  if (!existsSync(logPath)) return "";
  return readFileSync(logPath, "utf8");
}

function main(): void {
  const post = process.argv.includes("--post");
  const stateDir = resolveWingmanXStateDir();
  const logPath = join(stateDir, FLAGGED_REPLIES_LOG_FILE);

  const digest = renderDigest(readLog(logPath));
  process.stdout.write(`${digest}\n`);

  if (!post) {
    // Default run: NO network. Print the copy-paste command a human can run.
    process.stdout.write(
      [
        "To open a GitHub issue with this digest, re-run with --post, or run:",
        "",
        `  gh issue create --title ${JSON.stringify(ISSUE_TITLE)} --body-file -`,
        "",
      ].join("\n") + "\n",
    );
    return;
  }

  // Explicit human opt-in: fire `gh`. This is the ONLY network path.
  const result = spawnSync(
    "gh",
    ["issue", "create", "--title", ISSUE_TITLE, "--body-file", "-"],
    { input: digest, stdio: ["pipe", "inherit", "inherit"], encoding: "utf8" },
  );
  if (result.error !== undefined) {
    process.stderr.write(
      `humanizer-digest: failed to invoke gh: ${result.error.message}\n`,
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main();
