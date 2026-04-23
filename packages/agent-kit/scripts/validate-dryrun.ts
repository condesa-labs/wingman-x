#!/usr/bin/env tsx
import { CandidateInputSchema } from "../src/candidate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const jsonPath = resolve(here, "dryrun-candidates.json");
const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));

let allValid = true;
for (const c of raw) {
  const res = CandidateInputSchema.safeParse(c);
  const len = [...c.suggested_reply].length;
  const status = res.success ? "OK" : "FAIL";
  console.log(`[${status}] ${c.author_handle}  reply_codepoints=${len}  tweet_id=${c.tweet_id}`);
  if (!res.success) {
    allValid = false;
    for (const issue of res.error.issues) {
      console.log(`    - ${issue.path.join(".")}: ${issue.message}`);
    }
  }
}
process.exit(allValid ? 0 : 1);
