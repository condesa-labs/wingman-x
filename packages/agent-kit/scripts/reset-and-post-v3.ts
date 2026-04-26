#!/usr/bin/env tsx
/**
 * reset-and-post-v3.ts — clear the extension's visible queue and POST the
 * 5 v3 (selected-handle) candidates so the popup shows exactly the fresh
 * batch.
 *
 * Steps:
 *   1. GET /candidates — list what's in the daemon now.
 *   2. For each candidate whose status !== "dismissed", POST
 *      /candidates/:id/action { action: "dismissed" } to hide it in popup.
 *   3. POST /candidates with the v3 batch (all with status: "pending").
 *   4. GET /candidates — verify.
 *
 * State on disk (~/.twitter-helper/state.json) is preserved. Only the
 * popup's "visible queue" changes.
 */
import "../../../scripts/load-env.mjs";
import { createDaemonClient } from "../src/client.js";
import { CandidateInputSchema } from "../src/candidate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const jsonPath = resolve(here, "dryrun-v3-candidates.json");
const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));

const PORT = Number(process.env.DAEMON_PORT ?? "53827");

async function main(): Promise<void> {
  const base = `http://localhost:${PORT}`;

  // 1) Enumerate current pool
  const listRes = await fetch(`${base}/candidates`);
  const listBody = (await listRes.json()) as { candidates: any[] };
  console.log(`before: ${listBody.candidates.length} total in daemon state`);
  for (const c of listBody.candidates) {
    console.log(`  - ${c.author_handle}  status=${c.status}  tweet_id=${c.tweet_id}`);
  }

  // 2) Dismiss anything not already dismissed
  const toDismiss = listBody.candidates.filter((c) => c.status !== "dismissed");
  console.log(`\nDismissing ${toDismiss.length} non-dismissed entries...`);
  for (const c of toDismiss) {
    const r = await fetch(
      `${base}/candidates/${encodeURIComponent(c.tweet_id)}/action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "dismissed" }),
      },
    );
    console.log(`  ${c.author_handle} → ${r.status} ${r.ok ? "OK" : await r.text()}`);
  }

  // 3) POST v3 with explicit status: "pending" so they surface as fresh
  const toPost = raw.map((c: any) => {
    const withStatus = { ...c, status: "pending" as const };
    const parsed = CandidateInputSchema.safeParse(withStatus);
    if (!parsed.success)
      throw new Error(
        `invalid v3 candidate ${c.author_handle}: ${JSON.stringify(parsed.error.issues)}`,
      );
    return parsed.data;
  });

  const client = createDaemonClient(PORT);
  console.log(`\nPOSTing ${toPost.length} v3 candidates (status=pending)...`);
  const postRes = await client.postCandidates(toPost);
  console.log(`  result: ${JSON.stringify(postRes)}`);

  // 4) Verify
  const afterRes = await fetch(`${base}/candidates`);
  const afterBody = (await afterRes.json()) as { candidates: any[] };
  const visible = afterBody.candidates.filter((c) => c.status !== "dismissed");
  console.log(
    `\nafter: ${afterBody.candidates.length} total, ${visible.length} visible in popup`,
  );
  for (const c of visible) {
    console.log(`  • ${c.author_handle}  status=${c.status}  tweet_id=${c.tweet_id}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", (err as Error).message);
  process.exit(1);
});
