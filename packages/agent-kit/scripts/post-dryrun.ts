#!/usr/bin/env tsx
import "../../../scripts/load-env.mjs";
import { createDaemonClient } from "../src/client.js";
import { CandidateInputSchema } from "../src/candidate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const jsonPath = resolve(here, "dryrun-candidates.json");
const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));

// Validate up front so we don't send garbage and get a 400.
const validated = raw.map((c: unknown, i: number) => {
  const r = CandidateInputSchema.safeParse(c);
  if (!r.success) {
    throw new Error(
      `candidate[${i}] invalid: ${JSON.stringify(r.error.issues)}`,
    );
  }
  return r.data;
});

const PORT = Number(process.env.DAEMON_PORT ?? "53827");
const client = createDaemonClient(PORT);

console.log(`POSTing ${validated.length} candidates to daemon on :${PORT}...`);
try {
  const result = await client.postCandidates(validated);
  console.log("OK", JSON.stringify(result));
} catch (err) {
  console.error("FAILED", (err as Error).message);
  process.exit(1);
}

console.log("\nVerifying via GET /candidates...");
const res = await fetch(`http://localhost:${PORT}/candidates`);
const body = (await res.json()) as { candidates: unknown[] };
console.log(`daemon pool now holds ${body.candidates.length} candidate(s)`);
